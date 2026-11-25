import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  chown,
  link,
  lstat,
  open,
  readdir,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

export const databaseRoles = [
  'migrator',
  'seed',
  'api',
  'worker',
  'relay',
] as const;
export type DatabaseRole = (typeof databaseRoles)[number];
const secretRoles = ['admin', ...databaseRoles] as const;
export type SecretRole = (typeof secretRoles)[number] | 'operations';

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export function validDatabasePassword(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}

export async function readDatabasePassword(
  root: string,
  role: SecretRole,
): Promise<string> {
  const file = await open(
    join(root, role, 'password'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== 1000 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size !== 43
    )
      throw new Error('Invalid database secret file');
    const value = await file.readFile('utf8');
    if (!validDatabasePassword(value))
      throw new Error('Invalid database secret file');
    return value;
  } finally {
    await file.close();
  }
}

async function prepareVolume(directory: string): Promise<void> {
  let stat = await lstat(directory);
  if (!stat.isDirectory()) throw new Error('Invalid secret volume');
  if (stat.uid === 0 && (await readdir(directory)).length === 0) {
    await chmod(directory, 0o700);
    await chown(directory, 1000, 1000);
    stat = await lstat(directory);
  }
  if (stat.uid !== 1000 || (stat.mode & 0o777) !== 0o700)
    throw new Error('Invalid secret volume');
}

async function syncDirectory(directory: string): Promise<void> {
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

export async function initializeSecretVolumes(
  root: string,
  postgresData: string,
): Promise<void> {
  if (process.getuid?.() !== 0)
    throw new Error('Secret volume initialization requires root');
  let initialized = true;
  try {
    await lstat(join(postgresData, 'PG_VERSION'));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    initialized = false;
  }
  // Existing PostgreSQL data forbids regenerating any missing database password.
  if (initialized)
    for (const role of secretRoles) await readDatabasePassword(root, role);
  for (const role of [...secretRoles, 'demo'])
    await prepareVolume(join(root, role));
  // The additive operations credential is published by bootstrap only after it
  // checks the existing login. Legacy fixtures need no operations mount.
  try {
    await lstat(join(root, 'operations'));
    await prepareVolume(join(root, 'operations'));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }

  for (const role of secretRoles) {
    try {
      await readDatabasePassword(root, role);
      continue;
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    const directory = join(root, role);
    const temporary = join(directory, `.password-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(randomBytes(32).toString('base64url'));
        await file.chmod(0o600);
        await file.chown(1000, 1000);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, join(directory, 'password'));
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
      await syncDirectory(directory);
    } finally {
      await unlink(temporary);
    }
    await readDatabasePassword(root, role);
  }
}
