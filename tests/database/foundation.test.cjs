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
  expect(applied).toBe(1);
  const { rows } = await migrator.query(
    'SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  expect(rows).toEqual([{ current_user: 'lab_migrator', rolsuper: false }]);
  const tables = await migrator.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'lab' ORDER BY tablename",
  );
  expect(tables.rows.map((row) => row.tablename)).toEqual([
    'auth_credentials',
    'principals',
    'schema_migrations',
    'tenants',
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
  ).toBe(1);
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
      join(dir, '1794787200001_checkpoint.cjs'),
      "exports.up = pgm => pgm.sql('CREATE TABLE lab.rollback_checkpoint(id int)');",
    );
    await writeFile(
      join(dir, '1794787200002_failure.cjs'),
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
    ).toBe(1);
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
