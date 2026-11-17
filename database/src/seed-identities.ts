import { timingSafeEqual } from 'node:crypto';
import type { Client } from 'pg';
import { identityFixture } from './identity-fixture.js';
import {
  createManifest,
  fixtureDigest,
  IdentityProvisioningError,
  manifestDigest,
  prepareDirectory,
  readManifest,
  secretDigest,
  syncDirectory,
  type IdentityManifest,
} from './identity-manifest.js';

export interface IdentitySeedResult {
  status: 'created' | 'unchanged';
  fixtureVersion: 'identities-v1';
}

function sameDigest(actual: Buffer | null, expected: Buffer): boolean {
  return (
    Buffer.isBuffer(actual) &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

async function verifyIdentities(
  seed: Client,
  manifest: IdentityManifest,
): Promise<void> {
  for (const tenant of identityFixture.tenants) {
    const result = await seed.query<{ name: string }>(
      'SELECT name FROM lab.tenants WHERE id=$1',
      [tenant.id],
    );
    if (result.rows[0]?.name !== tenant.name)
      throw new IdentityProvisioningError('Identity fixture changed');
  }
  for (const principal of identityFixture.principals) {
    const credential = manifest.credentials.find(
      (c) => c.alias === principal.alias,
    );
    if (!credential)
      throw new IdentityProvisioningError('Invalid identity manifest');
    const result = await seed.query<{
      tenant_id: string;
      role: string;
      secret_digest: Buffer | null;
    }>(
      `SELECT p.tenant_id, p.role, c.secret_digest FROM lab.principals p
       LEFT JOIN lab.auth_credentials c ON c.principal_id=p.id AND c.id=$2 WHERE p.id=$1`,
      [principal.id, credential.lookupId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.tenant_id !== identityFixture.tenants[principal.tenant].id ||
      row.role !== principal.role ||
      !sameDigest(row.secret_digest, secretDigest(credential.secret))
    ) {
      throw new IdentityProvisioningError('Identity fixture changed');
    }
  }
}

export async function seedDemoIdentities(
  seed: Client,
  directory: string,
): Promise<IdentitySeedResult> {
  await seed.query('BEGIN');
  try {
    await seed.query("SET LOCAL lock_timeout='5s'");
    await seed.query("SET LOCAL statement_timeout='10s'");
    const identity = await seed.query<{ allowed: boolean }>(
      "SELECT current_user='lab_seed' AND NOT rolsuper AS allowed FROM pg_roles WHERE rolname=current_user",
    );
    if (!identity.rows[0]?.allowed)
      throw new IdentityProvisioningError('Identity seed role required');
    await seed.query('SELECT pg_advisory_xact_lock(41017, 2)');
    const state = (
      await seed.query<{ fixture_digest: Buffer; credentials_digest: Buffer }>(
        'SELECT fixture_digest,credentials_digest FROM lab.seed_manifests WHERE name=$1',
        [identityFixture.version],
      )
    ).rows[0];
    await prepareDirectory(directory, Boolean(state));
    let manifest = await readManifest(directory);
    if (state) {
      if (!manifest)
        throw new IdentityProvisioningError('Identity manifest missing');
      if (
        !sameDigest(state.fixture_digest, fixtureDigest) ||
        !sameDigest(state.credentials_digest, manifestDigest(manifest))
      ) {
        throw new IdentityProvisioningError('Identity manifest changed');
      }
      await verifyIdentities(seed, manifest);
    } else {
      const collision = await seed.query<{ present: boolean }>(
        `SELECT EXISTS(SELECT FROM lab.tenants WHERE id=ANY($1::uuid[])) OR
         EXISTS(SELECT FROM lab.principals WHERE id=ANY($2::uuid[])) AS present`,
        [
          identityFixture.tenants.map((t) => t.id),
          identityFixture.principals.map((p) => p.id),
        ],
      );
      if (collision.rows[0]?.present)
        throw new IdentityProvisioningError('Identity fixture collision');
      manifest ??= await createManifest(directory);
      // Durable file publication precedes every database effect. A rolled-back seed reuses it.
      await syncDirectory(directory);
      for (const tenant of identityFixture.tenants) {
        await seed.query('INSERT INTO lab.tenants(id,name) VALUES($1,$2)', [
          tenant.id,
          tenant.name,
        ]);
      }
      for (const principal of identityFixture.principals) {
        const credential = manifest.credentials.find(
          (c) => c.alias === principal.alias,
        );
        if (!credential)
          throw new IdentityProvisioningError('Invalid identity manifest');
        await seed.query(
          'INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,$3)',
          [
            principal.id,
            identityFixture.tenants[principal.tenant].id,
            principal.role,
          ],
        );
        await seed.query(
          'INSERT INTO lab.auth_credentials(id,principal_id,secret_digest) VALUES($1,$2,$3)',
          [credential.lookupId, principal.id, secretDigest(credential.secret)],
        );
      }
      await seed.query(
        'INSERT INTO lab.seed_manifests(name,fixture_digest,credentials_digest) VALUES($1,$2,$3)',
        [identityFixture.version, fixtureDigest, manifestDigest(manifest)],
      );
    }
    await seed.query('COMMIT');
    return {
      status: state ? 'unchanged' : 'created',
      fixtureVersion: identityFixture.version,
    };
  } catch (error) {
    try {
      await seed.query('ROLLBACK');
    } catch {
      throw new IdentityProvisioningError(
        'Identity provisioning failed; inspect durable state before retry',
      );
    }
    if (error instanceof IdentityProvisioningError) throw error;
    throw new IdentityProvisioningError('Identity provisioning failed');
  }
}
