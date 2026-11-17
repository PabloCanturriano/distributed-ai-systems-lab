import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import type { Client } from 'pg';

// The caller owns connections and credentials. Never invoke bootstrap from API/worker startup.
export async function bootstrapDatabase(admin: Client): Promise<void> {
  const sql = await readFile(
    new URL('../bootstrap/001-roles.sql', import.meta.url),
    'utf8',
  );
  await admin.query('BEGIN');
  try {
    await admin.query("SET LOCAL lock_timeout = '5s'");
    await admin.query("SET LOCAL statement_timeout = '10s'");
    await admin.query(sql);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

export async function migrateDatabase(
  migrator: Client,
  directory = fileURLToPath(new URL('../migrations/', import.meta.url)),
): Promise<number> {
  const identity = await migrator.query<{ allowed: boolean }>(
    "SELECT current_user = 'lab_migrator' AND NOT rolsuper AS allowed FROM pg_roles WHERE rolname = current_user",
  );
  if (!identity.rows[0]?.allowed)
    throw new Error('Migration identity must be lab_migrator');
  await migrator.query("SET lock_timeout = '5s'");
  await migrator.query("SET statement_timeout = '10s'");
  const applied = await runner({
    dbClient: migrator,
    dir: directory,
    direction: 'up',
    schema: 'lab',
    migrationsSchema: 'lab',
    migrationsTable: 'schema_migrations',
    checkOrder: true,
    singleTransaction: true,
    noLock: false,
    // Detailed migration diagnostics are not sent to default application logs.
    logger: { info() {}, warn() {}, error() {} },
  });
  return applied.length;
}

export {
  seedDemoIdentities,
  type IdentitySeedResult,
} from './seed-identities.js';
