import { readFile } from 'node:fs/promises';
import { provisionOperationsLogin } from './operations-login.js';
import { Client, escapeIdentifier } from 'pg';
import { z } from 'zod';
import {
  bootstrapDatabase,
  migrateDatabase,
  seedDemoIdentities,
  seedKnowledge,
} from './index.js';
import { provisionDatabaseLogins } from './database-logins.js';
import {
  databaseRoles,
  initializeSecretVolumes,
  readDatabasePassword,
  type DatabaseRole,
} from './database-secrets.js';

const settings = z.object({
  APP_MODE: z.literal('local').default('local'),
  DB_HOST: z.string().min(1).max(253).default('postgres'),
  DB_PORT: z
    .string()
    .regex(/^[1-9][0-9]{0,4}$/)
    .transform(Number)
    .pipe(z.number().max(65535))
    .default(5432),
  DB_NAME: z.literal('lab').default('lab'),
});

async function main(): Promise<void> {
  const parsed = settings.safeParse(process.env);
  if (!parsed.success || process.argv.length !== 3)
    throw new Error('Invalid initialization configuration');
  const configuration = parsed.data;
  const root = '/run/lab';
  const action = process.argv[2];
  if (action === 'secrets') {
    await initializeSecretVolumes(root, '/var/lib/lab/postgres');
    console.log(JSON.stringify({ event: 'secrets_complete' }));
    return;
  }
  if (action !== 'bootstrap' && action !== 'migrate' && action !== 'seed')
    throw new Error('Invalid initialization action');
  async function connect(
    role: 'admin' | DatabaseRole | 'operations',
  ): Promise<Client> {
    const client = new Client({
      host: configuration.DB_HOST,
      port: configuration.DB_PORT,
      database: configuration.DB_NAME,
      user: role === 'admin' ? 'lab_admin' : `lab_${role}_login`,
      password: await readDatabasePassword(root, role),
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      lock_timeout: 5000,
    });
    await client.connect();
    try {
      if (role !== 'admin')
        await client.query(`SET ROLE ${escapeIdentifier(`lab_${role}`)}`);
      return client;
    } catch (error) {
      await client.end();
      throw error;
    }
  }
  const client = await connect(
    action === 'bootstrap'
      ? 'admin'
      : action === 'migrate'
        ? 'migrator'
        : 'seed',
  );
  try {
    if (action === 'bootstrap') {
      await bootstrapDatabase(client);
      const passwords = {
        migrator: await readDatabasePassword(root, 'migrator'),
        seed: await readDatabasePassword(root, 'seed'),
        api: await readDatabasePassword(root, 'api'),
        worker: await readDatabasePassword(root, 'worker'),
        relay: await readDatabasePassword(root, 'relay'),
      };
      await provisionDatabaseLogins(client, passwords);
      // Authentication proves existing passwords still match; never rotate mismatched logins.
      for (const role of databaseRoles) {
        const probe = await connect(role);
        await probe.end();
      }
      await provisionOperationsLogin(client, root);
      const operations = await connect('operations');
      await operations.end();
      console.log(JSON.stringify({ event: 'bootstrap_complete' }));
    } else if (action === 'migrate') {
      const applied = await migrateDatabase(client);
      console.log(JSON.stringify({ event: 'migrations_complete', applied }));
    } else {
      const result = await seedDemoIdentities(
        client,
        '/run/lab/demo/identities',
      );
      console.log(JSON.stringify({ event: 'identities_complete', ...result }));
      const knowledge = await seedKnowledge(
        client,
        JSON.parse(await readFile('fixtures/knowledge/corpus-v1.json', 'utf8')),
      );
      console.log(
        JSON.stringify({ event: 'knowledge_complete', ...knowledge }),
      );
    }
  } finally {
    await client.end();
  }
}

void main().catch(() => {
  console.error(JSON.stringify({ event: 'initialization_failed' }));
  process.exitCode = 1;
});
