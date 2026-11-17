import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { identityFixture } from './identity-fixture.js';

export class IdentityProvisioningError extends Error {}
export const manifestFilename = 'identities-v1.json';
export const fixtureDigest = createHash('sha256')
  .update(JSON.stringify(identityFixture))
  .digest();

const manifestSchema = z.strictObject({
  version: z.literal('identities-v1'),
  fixtureDigest: z.literal(fixtureDigest.toString('hex')),
  credentials: z
    .array(
      z.strictObject({
        alias: z.string(),
        lookupId: z.uuid().regex(/^[0-9a-f-]+$/),
        secret: z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .refine((value) => {
            const bytes = Buffer.from(value, 'base64url');
            return bytes.length === 32 && bytes.toString('base64url') === value;
          }),
      }),
    )
    .length(6),
});
export type IdentityManifest = z.infer<typeof manifestSchema>;

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export async function prepareDirectory(
  directory: string,
  initialized: boolean,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    if (initialized)
      throw new IdentityProvisioningError('Identity manifest missing');
    await mkdir(directory, { mode: 0o700 });
    stat = await lstat(directory);
  }
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  ) {
    throw new IdentityProvisioningError(
      'Identity directory must be private and owned by the process user',
    );
  }
  // Persist the directory entry as well as its eventual contents, including on retry.
  // Parent paths are trusted and may contain operator-managed symbolic links.
  const parent = await open(
    dirname(resolve(directory)),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export async function readManifest(
  directory: string,
): Promise<IdentityManifest | undefined> {
  let file;
  try {
    file = await open(
      join(directory, manifestFilename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new IdentityProvisioningError(
        'Identity manifest must be a small private regular file',
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(await file.readFile('utf8'));
    } catch {
      throw new IdentityProvisioningError('Invalid identity manifest');
    }
    const result = manifestSchema.safeParse(decoded);
    if (!result.success)
      throw new IdentityProvisioningError('Invalid identity manifest');
    const aliases = new Set(
      result.data.credentials.map((entry) => entry.alias),
    );
    const ids = new Set(result.data.credentials.map((entry) => entry.lookupId));
    if (
      aliases.size !== 6 ||
      ids.size !== 6 ||
      identityFixture.principals.some((p) => !aliases.has(p.alias))
    ) {
      throw new IdentityProvisioningError('Invalid identity manifest');
    }
    return result.data;
  } finally {
    await file.close();
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createManifest(
  directory: string,
): Promise<IdentityManifest> {
  const manifest: IdentityManifest = {
    version: identityFixture.version,
    fixtureDigest: fixtureDigest.toString('hex'),
    credentials: identityFixture.principals.map((p) => ({
      alias: p.alias,
      lookupId: randomUUID(),
      secret: randomBytes(32).toString('base64url'),
    })),
  };
  const temporary = join(directory, `.identity-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(manifest));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, join(directory, manifestFilename));
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    await syncDirectory(directory);
  } finally {
    await unlink(temporary);
  }
  const stored = await readManifest(directory);
  if (!stored) throw new IdentityProvisioningError('Identity manifest missing');
  return stored;
}

export function manifestDigest(manifest: IdentityManifest): Buffer {
  return createHash('sha256').update(JSON.stringify(manifest)).digest();
}
export function secretDigest(secret: string): Buffer {
  return createHash('sha256').update(Buffer.from(secret, 'base64url')).digest();
}
