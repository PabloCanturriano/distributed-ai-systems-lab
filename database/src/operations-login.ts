import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, link, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from 'pg';
import { readDatabasePassword } from './database-secrets.js';
import { provisionDatabaseLogins } from './database-logins.js';
export async function provisionOperationsLogin(
  admin: Client,
  root: string,
): Promise<void> {
  const directory = join(root, 'operations'),
    stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== 1000 || (stat.mode & 0o777) !== 0o700)
    throw new Error('Invalid operations credential directory');
  let missing = false;
  try {
    await readDatabasePassword(root, 'operations');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      missing = true;
    else throw error;
  }
  if (missing) {
    if (
      (
        await admin.query(
          "SELECT 1 FROM pg_roles WHERE rolname='lab_operations_login'",
        )
      ).rowCount !== 0
    )
      throw new Error('Existing operations credential missing');
    const temporary = join(directory, `.password-${randomUUID()}.tmp`),
      file = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    try {
      try {
        await file.writeFile(randomBytes(32).toString('base64url'));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, join(directory, 'password'));
      } catch (error) {
        if (!(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EEXIST'
        ))
          throw error;
      }
      const parent = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await unlink(temporary);
    }
  }
  const password = await readDatabasePassword(root, 'operations');
  // Published material survives a failed transaction, so a retry reuses it.
  await provisionDatabaseLogins(admin, { operations: password }, [
    'operations',
  ]);
}
