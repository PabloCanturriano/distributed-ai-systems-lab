const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { Client, escapeIdentifier, escapeLiteral } = require('pg');
const { randomBytes } = require('node:crypto');

const image =
  'pgvector/pgvector:0.8.7-pg17-bookworm@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd';
class LoopbackPostgreSQL extends PostgreSqlContainer {
  async beforeContainerCreated() {
    this.hostConfig.PortBindings['5432/tcp'] = [
      { HostIp: '127.0.0.1', HostPort: '0' },
    ];
  }
}

let container;
let bootstrapDatabase;
let migrateDatabase;
let admin;
let migrator;

async function connectAs(role) {
  let user = container.getUsername();
  let password = container.getPassword();
  if (role) {
    user = `fixture_${role}_${randomBytes(4).toString('hex')}`;
    password = randomBytes(32).toString('base64url');
    // Utility statements cannot bind role names or passwords. Escape each value explicitly.
    await admin.query(
      `CREATE ROLE ${escapeIdentifier(user)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`,
    );
    await admin.query(
      `GRANT ${escapeIdentifier(role)} TO ${escapeIdentifier(user)}`,
    );
    await admin.query(
      `GRANT CONNECT ON DATABASE ${escapeIdentifier(container.getDatabase())} TO ${escapeIdentifier(user)}`,
    );
  }
  const client = new Client({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user,
    password,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    lock_timeout: 5000,
  });
  await client.connect();
  try {
    if (role) await client.query(`SET ROLE ${escapeIdentifier(role)}`);
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

beforeAll(async () => {
  ({ bootstrapDatabase, migrateDatabase } =
    await import('../../database/dist/index.js'));
  container = await new LoopbackPostgreSQL(image)
    .withDatabase('lab_test')
    .withPassword(randomBytes(32).toString('base64url'))
    .withStartupTimeout(120000)
    .start();
  admin = await connectAs();
  await bootstrapDatabase(admin);
  migrator = await connectAs('lab_migrator');
}, 180000);

afterAll(async () => {
  try {
    await migrator?.end();
  } finally {
    try {
      await admin?.end();
    } finally {
      await container?.stop();
    }
  }
});

test('clean install applies the identity migration as the non-superuser owner', async () => {
  const applied = await migrateDatabase(migrator);
  expect(applied).toBe(6);
  const { rows } = await migrator.query(
    'SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  expect(rows).toEqual([{ current_user: 'lab_migrator', rolsuper: false }]);
  const tables = await migrator.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'lab' ORDER BY tablename",
  );
  expect(tables.rows.map((row) => row.tablename)).toEqual([
    'auth_credentials',
    'consumer_inbox',
    'event_quarantine',
    'execution_jobs',
    'idempotency_records',
    'outbox_events',
    'principals',
    'schema_migrations',
    'seed_manifests',
    'tenants',
    'ticket_executions',
    'tickets',
  ]);
});

test('a second bootstrap/migration preserves existing rows and migration history', async () => {
  const tenant = '10000000-0000-4000-8000-000000000001';
  await migrator.query('INSERT INTO lab.tenants(id, name) VALUES ($1, $2)', [
    tenant,
    'Fictional persistence fixture',
  ]);
  await bootstrapDatabase(admin);
  expect(await migrateDatabase(migrator)).toBe(0);
  expect(
    (await migrator.query('SELECT name FROM lab.tenants WHERE id=$1', [tenant]))
      .rows,
  ).toEqual([{ name: 'Fictional persistence fixture' }]);
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS count FROM lab.schema_migrations',
      )
    ).rows[0].count,
  ).toBe(6);
});

test('bootstrap installs pgvector and keeps all five privilege roles non-login and non-admin', async () => {
  const roles = await admin.query(
    'SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)',
    [['lab_migrator', 'lab_seed', 'lab_api', 'lab_worker', 'lab_relay']],
  );
  expect(roles.rows).toHaveLength(5);
  for (const role of roles.rows)
    expect(Object.values(role)).toEqual(Array(7).fill(false));
  expect(
    (
      await admin.query(
        "SELECT extversion FROM pg_extension WHERE extname='vector'",
      )
    ).rows,
  ).toEqual([{ extversion: '0.8.7' }]);
  const version = (await admin.query('SHOW server_version_num')).rows[0]
    .server_version_num;
  expect(Number(version)).toBeGreaterThanOrEqual(170012);
  console.log(`PostgreSQL server_version_num=${version}; pgvector=0.8.7`);
  expect(Number(version)).toBeLessThan(180000);
});

test('migration wrapper rejects accidental privileged execution', async () => {
  await expect(migrateDatabase(admin)).rejects.toThrow(
    'Migration identity must be lab_migrator',
  );
});

for (const role of ['lab_api', 'lab_worker', 'lab_relay']) {
  test(`${role} cannot change schema, migrate, create roles or write identity data`, async () => {
    const client = await connectAs(role);
    try {
      for (const sql of [
        'CREATE TABLE lab.forbidden(id int)',
        'CREATE TABLE public.forbidden(id int)',
        'CREATE SCHEMA forbidden',
        'CREATE ROLE forbidden',
        "INSERT INTO lab.tenants(id,name) VALUES (gen_random_uuid(),'Forbidden fixture')",
        'SELECT * FROM lab.schema_migrations',
        'SET ROLE lab_migrator',
      ])
        await expect(client.query(sql)).rejects.toMatchObject({
          code: '42501',
        });
      await expect(migrateDatabase(client)).rejects.toThrow(
        'Migration identity must be lab_migrator',
      );
      if (role === 'lab_api') {
        expect(
          (await client.query('SELECT count(*)::int AS count FROM lab.tenants'))
            .rows[0].count,
        ).toBe(1);
      } else {
        await expect(
          client.query('SELECT * FROM lab.auth_credentials'),
        ).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await client.end();
    }
  });
}

test('seed role can create fictional identities but cannot replace or erase them', async () => {
  const seed = await connectAs('lab_seed');
  try {
    const tenant = '10000000-0000-4000-8000-000000000002';
    const principal = '20000000-0000-4000-8000-000000000001';
    await seed.query('INSERT INTO lab.tenants(id,name) VALUES($1,$2)', [
      tenant,
      'Fictional seed fixture',
    ]);
    await seed.query(
      'INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,$3)',
      [principal, tenant, 'requester'],
    );
    await seed.query(
      'INSERT INTO lab.auth_credentials(id,principal_id,secret_digest) VALUES($1,$2,$3)',
      ['30000000-0000-4000-8000-000000000001', principal, randomBytes(32)],
    );
    await expect(seed.query('DELETE FROM lab.tenants')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      seed.query("UPDATE lab.principals SET role='operator'"),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      seed.query('CREATE TABLE lab.forbidden(id int)'),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await seed.end();
  }
});

test('identity constraints reject dangling references, invalid roles, and invalid credential digests', async () => {
  const tenant = '10000000-0000-4000-8000-000000000001';
  const principal = '20000000-0000-4000-8000-000000000002';
  await expect(
    migrator.query(
      'INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,$3)',
      [principal, '99999999-0000-4000-8000-000000000001', 'requester'],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    migrator.query(
      'INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,$3)',
      [principal, tenant, 'admin'],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await migrator.query(
    'INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,$3)',
    [principal, tenant, 'reader'],
  );
  await expect(
    migrator.query(
      'INSERT INTO lab.auth_credentials(id,principal_id,secret_digest) VALUES($1,$2,$3)',
      ['30000000-0000-4000-8000-000000000002', principal, Buffer.alloc(1)],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

test('a failing pending batch rolls back both schema changes and migration history', async () => {
  const { mkdtemp, cp, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lab-migration-failure-'));
  try {
    await cp('database/migrations', dir, { recursive: true });
    await writeFile(
      join(dir, '1794873600010_checkpoint.cjs'),
      "exports.up = pgm => pgm.sql('CREATE TABLE lab.rollback_checkpoint(id int)');",
    );
    await writeFile(
      join(dir, '1794873600011_failure.cjs'),
      "exports.up = pgm => pgm.sql('SELECT missing_column FROM lab.tenants');",
    );
    await expect(migrateDatabase(migrator, dir)).rejects.toBeDefined();
    expect(
      (
        await migrator.query(
          "SELECT to_regclass('lab.rollback_checkpoint') AS relation",
        )
      ).rows[0].relation,
    ).toBeNull();
    expect(
      (
        await migrator.query(
          'SELECT count(*)::int AS count FROM lab.schema_migrations',
        )
      ).rows[0].count,
    ).toBe(6);
    expect(await migrateDatabase(migrator)).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bootstrap rejects a pre-existing elevated role without rewriting it', async () => {
  await admin.query('ALTER ROLE lab_relay LOGIN');
  try {
    await expect(bootstrapDatabase(admin)).rejects.toThrow(
      'incompatible attributes',
    );
    expect(
      (
        await admin.query(
          "SELECT rolcanlogin FROM pg_roles WHERE rolname='lab_relay'",
        )
      ).rows[0].rolcanlogin,
    ).toBe(true);
  } finally {
    await admin.query('ALTER ROLE lab_relay NOLOGIN');
  }
});

test('identity provisioning has an immutable database manifest anchor', async () => {
  const { rows } = await migrator.query(
    "SELECT to_regclass('lab.seed_manifests') IS NOT NULL AS present",
  );
  expect(rows[0].present).toBe(true);
});

describe('durable local identity provisioning', () => {
  const {
    mkdtemp,
    readFile,
    writeFile,
    unlink,
    chmod,
    stat,
    rm,
  } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { createHash } = require('node:crypto');
  const tenants = [
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
  ];
  let directory;
  let seed;
  let provision;
  const filename = () => join(directory, 'identities-v1.json');
  async function fileHash() {
    return createHash('sha256')
      .update(await readFile(filename()))
      .digest('hex');
  }
  async function readTestManifest() {
    try {
      return JSON.parse(await readFile(filename(), 'utf8'));
    } catch {
      throw new Error('Test identity manifest could not be parsed');
    }
  }
  async function counts() {
    const { rows } = await admin.query(
      `SELECT
      (SELECT count(*)::int FROM lab.tenants WHERE id=ANY($1::uuid[])) AS tenants,
      (SELECT count(*)::int FROM lab.principals WHERE tenant_id=ANY($1::uuid[])) AS principals,
      (SELECT count(*)::int FROM lab.auth_credentials c JOIN lab.principals p ON p.id=c.principal_id WHERE p.tenant_id=ANY($1::uuid[])) AS credentials`,
      [tenants],
    );
    return rows[0];
  }
  beforeEach(async () => {
    ({ seedDemoIdentities: provision } =
      await import('../../database/dist/index.js'));
    directory = await mkdtemp(join(tmpdir(), 'lab-private-identities-'));
    seed = await connectAs('lab_seed');
  });
  afterEach(async () => {
    try {
      await seed?.end();
    } finally {
      try {
        await admin.query(
          'DELETE FROM lab.auth_credentials WHERE principal_id IN (SELECT id FROM lab.principals WHERE tenant_id=ANY($1::uuid[]))',
          [tenants],
        );
        await admin.query(
          'DELETE FROM lab.principals WHERE tenant_id=ANY($1::uuid[])',
          [tenants],
        );
        await admin.query('DELETE FROM lab.tenants WHERE id=ANY($1::uuid[])', [
          tenants,
        ]);
        await admin.query(
          "DELETE FROM lab.seed_manifests WHERE name='identities-v1'",
        );
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test('creates two tenants and six private credentials, storing only secret digests in PostgreSQL', async () => {
    const result = await provision(seed, directory);
    expect(result).toEqual({
      status: 'created',
      fixtureVersion: 'identities-v1',
    });
    expect(await counts()).toEqual({
      tenants: 2,
      principals: 6,
      credentials: 6,
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(filename())).mode & 0o777).toBe(0o600);
    const manifest = await readTestManifest();
    expect(new Set(manifest.credentials.map((c) => c.lookupId)).size).toBe(6);
    expect(new Set(manifest.credentials.map((c) => c.secret)).size).toBe(6);
    const databaseRows = (
      await admin.query(
        'SELECT id,secret_digest FROM lab.auth_credentials WHERE principal_id IN (SELECT id FROM lab.principals WHERE tenant_id=ANY($1::uuid[]))',
        [tenants],
      )
    ).rows;
    for (const credential of manifest.credentials) {
      const bytes = Buffer.from(credential.secret, 'base64url');
      expect(bytes.length).toBe(32);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const stored = databaseRows.find((r) => r.id === credential.lookupId);
      expect(stored.secret_digest.toString('hex')).toBe(digest);
      expect(JSON.stringify(result).includes(credential.secret)).toBe(false);
      expect(JSON.stringify(databaseRows).includes(credential.secret)).toBe(
        false,
      );
    }
    await expect(
      seed.query('DELETE FROM lab.seed_manifests'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  test('repeated startup preserves credentials and honors revoked/disabled identities', async () => {
    await provision(seed, directory);
    const before = await fileHash();
    await admin.query(
      'UPDATE lab.principals SET disabled_at=CURRENT_TIMESTAMP WHERE tenant_id=ANY($1::uuid[])',
      [tenants],
    );
    await admin.query(
      'UPDATE lab.auth_credentials SET revoked_at=CURRENT_TIMESTAMP WHERE principal_id IN (SELECT id FROM lab.principals WHERE tenant_id=ANY($1::uuid[]))',
      [tenants],
    );
    expect(await provision(seed, directory)).toEqual({
      status: 'unchanged',
      fixtureVersion: 'identities-v1',
    });
    expect(await fileHash()).toBe(before);
    expect(await counts()).toEqual({
      tenants: 2,
      principals: 6,
      credentials: 6,
    });
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM lab.principals WHERE tenant_id=ANY($1::uuid[]) AND disabled_at IS NOT NULL',
          [tenants],
        )
      ).rows[0].count,
    ).toBe(6);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM lab.auth_credentials c JOIN lab.principals p ON p.id=c.principal_id WHERE p.tenant_id=ANY($1::uuid[]) AND c.revoked_at IS NOT NULL',
          [tenants],
        )
      ).rows[0].count,
    ).toBe(6);
  });

  test('concurrent initializers produce one committed manifest and no duplicate identities', async () => {
    const second = await connectAs('lab_seed');
    try {
      const blocker = await connectAs('lab_seed');
      const pids = [
        (await seed.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      ];
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(41017, 2)');
      const pending = Promise.allSettled([
        provision(seed, directory),
        provision(second, directory),
      ]);
      let waiting = 0;
      try {
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
          waiting = (
            await admin.query(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pid=ANY($1::int[])",
              [pids],
            )
          ).rows[0].count;
          if (waiting === 2) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await blocker.query('COMMIT');
        await blocker.end();
      }
      const settled = await pending;
      expect(waiting).toBe(2);
      expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(settled.map((r) => r.value.status).sort()).toEqual([
        'created',
        'unchanged',
      ]);
      expect(await counts()).toEqual({
        tenants: 2,
        principals: 6,
        credentials: 6,
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM lab.seed_manifests WHERE name='identities-v1'",
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await second.end();
    }
  });

  test('missing credential file after commit fails without replacing existing identities', async () => {
    await provision(seed, directory);
    const before = (
      await admin.query('SELECT credentials_digest FROM lab.seed_manifests')
    ).rows[0].credentials_digest.toString('hex');
    await unlink(filename());
    await expect(provision(seed, directory)).rejects.toThrow(
      'Identity manifest missing',
    );
    await expect(stat(filename())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await counts()).toEqual({
      tenants: 2,
      principals: 6,
      credentials: 6,
    });
    expect(
      (
        await admin.query('SELECT credentials_digest FROM lab.seed_manifests')
      ).rows[0].credentials_digest.toString('hex'),
    ).toBe(before);
  });

  test('changed secret material is rejected without updating database digests', async () => {
    await provision(seed, directory);
    const before = (
      await admin.query('SELECT credentials_digest FROM lab.seed_manifests')
    ).rows[0].credentials_digest.toString('hex');
    const manifest = await readTestManifest();
    manifest.credentials[0].secret = randomBytes(32).toString('base64url');
    await writeFile(filename(), JSON.stringify(manifest));
    await expect(provision(seed, directory)).rejects.toThrow(
      'Identity manifest changed',
    );
    expect(
      (
        await admin.query('SELECT credentials_digest FROM lab.seed_manifests')
      ).rows[0].credentials_digest.toString('hex'),
    ).toBe(before);
  });

  test('corrupt manifests fail with a generic message without echoing their contents', async () => {
    await writeFile(filename(), 'fictional-sensitive-invalid-json', {
      mode: 0o600,
    });
    await expect(provision(seed, directory)).rejects.toThrow(
      /^Invalid identity manifest$/,
    );
    expect(await counts()).toEqual({
      tenants: 0,
      principals: 0,
      credentials: 0,
    });
  });

  test('unsafe directory or file permissions are rejected', async () => {
    await chmod(directory, 0o755);
    await expect(provision(seed, directory)).rejects.toThrow(
      'Identity directory must be private',
    );
    await chmod(directory, 0o700);
    await provision(seed, directory);
    await chmod(filename(), 0o644);
    await expect(provision(seed, directory)).rejects.toThrow(
      'Identity manifest must be a small private regular file',
    );
  });

  test('changed fixture facts are detected rather than overwritten', async () => {
    await provision(seed, directory);
    await admin.query(
      "UPDATE lab.tenants SET name='Changed fictional name' WHERE id=$1",
      [tenants[0]],
    );
    await expect(provision(seed, directory)).rejects.toThrow(
      'Identity fixture changed',
    );
    expect(
      (
        await admin.query('SELECT name FROM lab.tenants WHERE id=$1', [
          tenants[0],
        ])
      ).rows[0].name,
    ).toBe('Changed fictional name');
  });

  test('file publication survives a failed seed transaction and retry reuses the same credentials', async () => {
    await admin.query(
      "CREATE FUNCTION lab.reject_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional seed failure'; END $$; CREATE TRIGGER reject_seed BEFORE INSERT ON lab.principals FOR EACH ROW EXECUTE FUNCTION lab.reject_seed()",
    );
    let before;
    try {
      await expect(provision(seed, directory)).rejects.toThrow(
        /^Identity provisioning failed$/,
      );
      before = await fileHash();
      expect(await counts()).toEqual({
        tenants: 0,
        principals: 0,
        credentials: 0,
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM lab.seed_manifests WHERE name='identities-v1'",
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await admin.query(
        'DROP TRIGGER reject_seed ON lab.principals; DROP FUNCTION lab.reject_seed()',
      );
    }
    expect((await provision(seed, directory)).status).toBe('created');
    expect(await fileHash()).toBe(before);
    expect(await counts()).toEqual({
      tenants: 2,
      principals: 6,
      credentials: 6,
    });
  });

  test('missing credential directory for an initialized database is not recreated', async () => {
    await provision(seed, directory);
    await rm(directory, { recursive: true });
    await expect(provision(seed, directory)).rejects.toThrow(
      'Identity manifest missing',
    );
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await counts()).toEqual({
      tenants: 2,
      principals: 6,
      credentials: 6,
    });
  });

  test('symbolic links and oversized manifests are rejected before database writes', async () => {
    const { symlink } = require('node:fs/promises');
    const target = join(directory, 'private-target.json');
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, filename());
    await expect(provision(seed, directory)).rejects.toThrow(
      /^Identity provisioning failed$/,
    );
    await unlink(filename());
    await writeFile(filename(), 'x'.repeat(16385), { mode: 0o600 });
    await expect(provision(seed, directory)).rejects.toThrow(
      'Identity manifest must be a small private regular file',
    );
    expect(await counts()).toEqual({
      tenants: 0,
      principals: 0,
      credentials: 0,
    });
  });

  test('a new private directory under an existing parent can be initialized and reused', async () => {
    const target = join(directory, 'credentials');
    expect((await provision(seed, target)).status).toBe('created');
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect((await stat(join(target, 'identities-v1.json'))).mode & 0o777).toBe(
      0o600,
    );
    expect((await provision(seed, target)).status).toBe('unchanged');
  });

  test('a non-seed identity cannot provision credentials', async () => {
    await expect(provision(migrator, directory)).rejects.toThrow(
      'Identity seed role required',
    );
    await expect(stat(filename())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test.each([2, 3, 4, 5])(
  'upgrading the seeded %i-migration baseline preserves credentials and existing data',
  async (baselineCount) => {
    const { mkdtemp, copyFile, rm } = require('node:fs/promises');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'lab-prior-migration-'));
    let upgrade;
    let created = false;
    try {
      await copyFile(
        'database/migrations/1794787200000_identity-foundation.cjs',
        join(directory, '1794787200000_identity-foundation.cjs'),
      );
      await copyFile(
        'database/migrations/1794787200010_seed-manifests.cjs',
        join(directory, '1794787200010_seed-manifests.cjs'),
      );
      if (baselineCount >= 3)
        await copyFile(
          'database/migrations/1794873600000_api-readiness.cjs',
          join(directory, '1794873600000_api-readiness.cjs'),
        );
      if (baselineCount >= 4)
        await copyFile(
          'database/migrations/1795046400000_ticket-submission.cjs',
          join(directory, '1795046400000_ticket-submission.cjs'),
        );
      if (baselineCount >= 5)
        await copyFile(
          'database/migrations/1795132800000_outbox-publication.cjs',
          join(directory, '1795132800000_outbox-publication.cjs'),
        );
      await admin.query('CREATE DATABASE lab_upgrade_test');
      created = true;
      upgrade = new Client({
        host: container.getHost(),
        port: container.getPort(),
        database: 'lab_upgrade_test',
        user: container.getUsername(),
        password: container.getPassword(),
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      });
      await upgrade.connect();
      await bootstrapDatabase(upgrade);
      // Upgrade-only fixture; role security is exercised with authenticated non-admin sessions above.
      await upgrade.query('SET ROLE lab_migrator');
      expect(await migrateDatabase(upgrade, directory)).toBe(baselineCount);
      await upgrade.query(
        "INSERT INTO lab.tenants(id,name) VALUES('90000000-0000-4000-8000-000000000001','Fictional upgrade fixture')",
      );
      const { seedDemoIdentities } =
        await import('../../database/dist/index.js');
      await upgrade.query('SET ROLE lab_seed');
      await seedDemoIdentities(upgrade, join(directory, 'private-identities'));
      let pendingEvent;
      if (baselineCount >= 4) {
        await upgrade.query('RESET ROLE');
        const {
          TicketSubmissions,
        } = require('../../apps/api/dist/ticket-submission.js');
        const source = {
          async connect() {
            return { query: upgrade.query.bind(upgrade), release() {} };
          },
        };
        await new TicketSubmissions(source).submit({
          tenantId: 'a1000000-0000-4000-8000-000000000001',
          principalId: 'a2000000-0000-4000-8000-000000000002',
          requestId: require('node:crypto').randomUUID(),
          key: 'upgrade-event',
          body: { message: 'Fictional preserved question' },
        });
        pendingEvent = (
          await upgrade.query(
            'SELECT event_id,payload,payload_digest FROM lab.outbox_events',
          )
        ).rows[0];
        await upgrade.query('SET ROLE lab_seed');
      }
      const before = (
        await upgrade.query(
          "SELECT encode(credentials_digest,'hex') AS digest FROM lab.seed_manifests",
        )
      ).rows[0].digest;
      await upgrade.query('SET ROLE lab_migrator');
      expect(await migrateDatabase(upgrade)).toBe(6 - baselineCount);
      if (pendingEvent) {
        const event = (
          await upgrade.query(
            'SELECT * FROM lab.outbox_events WHERE event_id=$1',
            [pendingEvent.event_id],
          )
        ).rows[0];
        expect(event.payload).toBe(pendingEvent.payload);
        expect(event.payload_digest).toEqual(pendingEvent.payload_digest);
        expect(event.publication_attempts).toBe(0);
        expect(event.claim_token).toBeNull();
        expect(event.published_at).toBeNull();
        expect(
          (await upgrade.query('SELECT message FROM lab.tickets')).rows[0]
            .message,
        ).toBe('Fictional preserved question');
      }
      expect(
        (
          await upgrade.query(
            "SELECT encode(credentials_digest,'hex') AS digest FROM lab.seed_manifests",
          )
        ).rows[0].digest,
      ).toBe(before);
      expect(
        (await upgrade.query('SELECT * FROM lab.api_readiness')).rows,
      ).toEqual([{ contract_version: 1, identities_ready: true }]);
      expect(await migrateDatabase(upgrade)).toBe(0);
      expect(
        (
          await upgrade.query(
            "SELECT name FROM lab.tenants WHERE id='90000000-0000-4000-8000-000000000001'",
          )
        ).rows,
      ).toEqual([{ name: 'Fictional upgrade fixture' }]);
      expect(
        (
          await upgrade.query(
            'SELECT count(*)::int AS count FROM lab.seed_manifests',
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await upgrade?.end();
      if (created) await admin.query('DROP DATABASE lab_upgrade_test');
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('database login provisioning preserves passwords and limits each login to its privilege group', async () => {
  const { provisionDatabaseLogins } =
    await import('../../database/dist/index.js');
  const roles = ['migrator', 'seed', 'api', 'worker', 'relay'];
  const passwords = Object.fromEntries(
    roles.map((role) => [role, randomBytes(32).toString('base64url')]),
  );
  await provisionDatabaseLogins(admin, passwords);
  await provisionDatabaseLogins(admin, passwords);
  // Supplying different values does not rewrite an existing login's password.
  await provisionDatabaseLogins(
    admin,
    Object.fromEntries(
      roles.map((role) => [role, randomBytes(32).toString('base64url')]),
    ),
  );
  for (const role of roles) {
    const client = new Client({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: `lab_${role}_login`,
      password: passwords[role],
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      await client.query(`SET ROLE lab_${role}`);
      expect(
        (await client.query('SELECT current_user')).rows[0].current_user,
      ).toBe(`lab_${role}`);
      if (role !== 'migrator')
        await expect(
          client.query('SET ROLE lab_migrator'),
        ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  }
  await admin.query('GRANT lab_migrator TO lab_api_login');
  try {
    await expect(provisionDatabaseLogins(admin, passwords)).rejects.toThrow(
      'Incompatible database login membership',
    );
  } finally {
    await admin.query('REVOKE lab_migrator FROM lab_api_login');
  }
  await expect(
    provisionDatabaseLogins(admin, { ...passwords, api: 'invalid' }),
  ).rejects.toThrow('Invalid database login material');
});

test('API readiness exposes only versioned bootstrap metadata and reflects committed seed state', async () => {
  const { seedDemoIdentities } = await import('../../database/dist/index.js');
  const { mkdtemp, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'lab-api-readiness-'));
  const seed = await connectAs('lab_seed');
  const api = await connectAs('lab_api');
  const tenants = [
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
  ];
  try {
    expect((await api.query('SELECT * FROM lab.api_readiness')).rows).toEqual([
      { contract_version: 1, identities_ready: false },
    ]);
    await expect(
      api.query('SELECT * FROM lab.seed_manifests'),
    ).rejects.toMatchObject({ code: '42501' });
    await seedDemoIdentities(seed, directory);
    expect((await api.query('SELECT * FROM lab.api_readiness')).rows).toEqual([
      { contract_version: 1, identities_ready: true },
    ]);
    await admin.query(
      "UPDATE lab.seed_manifests SET fixture_digest=decode(repeat('00',32),'hex') WHERE name='identities-v1'",
    );
    expect(
      (await api.query('SELECT * FROM lab.api_readiness')).rows[0]
        .identities_ready,
    ).toBe(false);
  } finally {
    await api.end();
    await seed.end();
    await admin.query(
      'DELETE FROM lab.auth_credentials WHERE principal_id IN (SELECT id FROM lab.principals WHERE tenant_id=ANY($1::uuid[]))',
      [tenants],
    );
    await admin.query(
      'DELETE FROM lab.principals WHERE tenant_id=ANY($1::uuid[])',
      [tenants],
    );
    await admin.query('DELETE FROM lab.tenants WHERE id=ANY($1::uuid[])', [
      tenants,
    ]);
    await admin.query(
      "DELETE FROM lab.seed_manifests WHERE name='identities-v1'",
    );
    await rm(directory, { recursive: true, force: true });
  }
});
