const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { Client, Pool, escapeIdentifier, escapeLiteral } = require('pg');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

class LoopbackPostgreSQL extends PostgreSqlContainer {
  async beforeContainerCreated() {
    this.hostConfig.PortBindings['5432/tcp'] = [
      { HostIp: '127.0.0.1', HostPort: '0' },
    ];
  }
}
const tenant = randomUUID();
const principal = randomUUID();
const otherTenant = randomUUID();
const otherPrincipal = randomUUID();
const reader = randomUUID();
const operator = randomUUID();
let container, admin, migrator, pool;
beforeAll(async () => {
  const { bootstrapDatabase, migrateDatabase } =
    await import('../../database/dist/index.js');
  container = await new LoopbackPostgreSQL(
    'pgvector/pgvector:0.8.7-pg17-bookworm@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd',
  )
    .withDatabase('ticket_submission_test')
    .withPassword(randomBytes(32).toString('base64url'))
    .withStartupTimeout(120000)
    .start();
  const configuration = {
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    lock_timeout: 5000,
  };
  admin = new Client(configuration);
  await admin.connect();
  await bootstrapDatabase(admin);
  migrator = new Client(configuration);
  await migrator.connect();
  await migrator.query('SET ROLE lab_migrator');
  await migrateDatabase(migrator);
  await migrator.query('INSERT INTO lab.tenants(id,name) VALUES ($1,$2)', [
    tenant,
    'Fictional ticket tenant',
  ]);
  await migrator.query(
    'INSERT INTO lab.principals(id,tenant_id,role) VALUES ($1,$2,$3)',
    [principal, tenant, 'requester'],
  );
  await migrator.query('INSERT INTO lab.tenants(id,name) VALUES ($1,$2)', [
    otherTenant,
    'Other fictional tenant',
  ]);
  await migrator.query(
    "INSERT INTO lab.principals(id,tenant_id,role) VALUES ($1,$2,'requester'),($3,$4,'reader'),($5,$4,'operator')",
    [otherPrincipal, otherTenant, reader, tenant, operator],
  );
  const login = `fixture_api_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(32).toString('base64url');
  await admin.query(
    `CREATE ROLE ${escapeIdentifier(login)} LOGIN NOINHERIT PASSWORD ${escapeLiteral(password)}`,
  );
  await admin.query(`GRANT lab_api TO ${escapeIdentifier(login)}`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${escapeIdentifier(configuration.database)} TO ${escapeIdentifier(login)}`,
  );
  pool = new Pool({
    ...configuration,
    user: login,
    password,
    max: 4,
    application_name: 'ticket-submission-test',
  });
}, 180000);
afterEach(async () => {
  await migrator.query(
    'TRUNCATE lab.idempotency_records, lab.outbox_events, lab.ticket_executions, lab.tickets',
  );
  await migrator.query('UPDATE lab.principals SET disabled_at=NULL');
});
afterAll(async () => {
  await pool?.end();
  await migrator?.end();
  await admin?.end();
  await container?.stop();
});

test('submission commits one ticket, execution, receipt and pending event together', async () => {
  const {
    TicketSubmissions,
  } = require('../../apps/api/dist/ticket-submission.js');
  const requestId = randomUUID();
  const receipt = await new TicketSubmissions(pool).submit({
    tenantId: tenant,
    principalId: principal,
    requestId,
    key: 'first-ticket',
    body: { message: '  How do I rotate an API key?  ' },
  });
  expect(receipt).toEqual({
    ticketId: expect.any(String),
    generation: 1,
    statusUrl: `/v1/tickets/${receipt.ticketId}`,
  });
  const ticket = await migrator.query(
    'SELECT message, current_generation FROM lab.tickets WHERE id=$1',
    [receipt.ticketId],
  );
  expect(ticket.rows).toEqual([
    { message: 'How do I rotate an API key?', current_generation: 1 },
  ]);
  for (const table of [
    'tickets',
    'ticket_executions',
    'idempotency_records',
    'outbox_events',
  ]) {
    expect(
      (await migrator.query(`SELECT count(*)::int AS count FROM lab.${table}`))
        .rows[0].count,
    ).toBe(1);
  }
  const event = (
    await migrator.query('SELECT payload,published_at FROM lab.outbox_events')
  ).rows[0];
  expect(JSON.parse(event.payload)).toMatchObject({
    type: 'ticket.execution.requested',
    version: 1,
    tenantId: tenant,
    ticketId: receipt.ticketId,
    generation: 1,
    correlationId: requestId,
    causationId: requestId,
    data: { reason: 'submitted' },
  });
  expect(event.published_at).toBeNull();
  const digest = (
    await migrator.query('SELECT payload_digest FROM lab.outbox_events')
  ).rows[0].payload_digest;
  expect(digest).toEqual(createHash('sha256').update(event.payload).digest());
});

function store(source = pool) {
  const {
    TicketSubmissions,
  } = require('../../apps/api/dist/ticket-submission.js');
  return new TicketSubmissions(source);
}

async function asApi(action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN; SET LOCAL ROLE lab_api');
    await action(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('a later lifecycle change does not change the original acceptance receipt', async () => {
  const command = input();
  const receipt = await store().submit(command);
  await migrator.query(
    "UPDATE lab.ticket_executions SET status='completed' WHERE ticket_id=$1",
    [receipt.ticketId],
  );
  expect(await store().submit(command)).toEqual(receipt);
  expect(await counts()).toEqual([1, 1, 1, 1]);
});

test('composite creator references reject cross-tenant rows independently of application checks', async () => {
  await asApi(async (client) => {
    await expect(
      client.query(
        'INSERT INTO lab.tickets(id,tenant_id,created_by,message,current_generation) VALUES($1,$2,$3,$4,1)',
        [randomUUID(), tenant, otherPrincipal, 'Fictional question'],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
  expect(await counts()).toEqual([0, 0, 0, 0]);
});

test('deferred execution integrity prevents committing an incomplete ticket or receipt', async () => {
  await asApi(async (client) => {
    await client.query(
      'INSERT INTO lab.tickets(id,tenant_id,created_by,message,current_generation) VALUES($1,$2,$3,$4,1)',
      [randomUUID(), tenant, principal, 'Fictional question'],
    );
    await expect(client.query('COMMIT')).rejects.toMatchObject({
      code: '23503',
    });
  });
  const held = await reservation();
  try {
    await expect(held.query('COMMIT')).rejects.toMatchObject({ code: '23503' });
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  expect(await counts()).toEqual([0, 0, 0, 0]);
});

test('API cannot rewrite receipts, event bytes or publication state', async () => {
  const receipt = await store().submit(input());
  for (const sql of [
    "UPDATE lab.idempotency_records SET key='changed'",
    "UPDATE lab.outbox_events SET payload='{}'",
    'UPDATE lab.outbox_events SET published_at=CURRENT_TIMESTAMP',
    'DELETE FROM lab.tickets',
  ]) {
    await asApi(async (client) => {
      await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    });
  }
  await asApi(async (client) => {
    const row = (await migrator.query('SELECT * FROM lab.outbox_events'))
      .rows[0];
    await expect(
      client.query(
        'INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest,published_at) VALUES($1,$2,$3,1,$4,1,$5,$6,CURRENT_TIMESTAMP)',
        [
          randomUUID(),
          tenant,
          receipt.ticketId,
          row.type,
          row.payload,
          row.payload_digest,
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  expect(await counts()).toEqual([1, 1, 1, 1]);
});

test('the outbox envelope constraint rejects missing metadata rather than allowing SQL NULL', async () => {
  const receipt = await store().submit(input());
  await asApi(async (client) => {
    await expect(
      client.query(
        'INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest) VALUES($1,$2,$3,1,$4,1,$5,$6)',
        [
          randomUUID(),
          tenant,
          receipt.ticketId,
          'ticket.execution.requested',
          '{}',
          randomBytes(32),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  expect(await counts()).toEqual([1, 1, 1, 1]);
});
function input(overrides = {}) {
  return {
    tenantId: tenant,
    principalId: principal,
    requestId: randomUUID(),
    key: 'request-key',
    body: { message: 'Fictional support question' },
    ...overrides,
  };
}
async function counts() {
  const result = {};
  for (const table of [
    'tickets',
    'ticket_executions',
    'idempotency_records',
    'outbox_events',
  ])
    result[table] = (
      await migrator.query(`SELECT count(*)::int AS count FROM lab.${table}`)
    ).rows[0].count;
  return Object.values(result);
}
async function waitForLock(event) {
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    const result = await admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='ticket-submission-test' AND wait_event_type='Lock' AND wait_event=$1",
      [event],
    );
    if (result.rows[0].count > 0) return;
    await delay(20);
  }
  throw new Error(`Expected checkpoint lock ${event}`);
}
async function reservation() {
  const client = await pool.connect();
  await client.query('BEGIN; SET LOCAL ROLE lab_api');
  const ticketId = randomUUID();
  await client.query(
    'INSERT INTO lab.idempotency_records(tenant_id,operation,resource_scope,key,request_hash,ticket_id,generation,receipt) VALUES($1,$2,$3,$4,$5,$6,1,$7)',
    [
      tenant,
      'tickets:create:v1',
      'tickets',
      'request-key',
      randomBytes(32),
      ticketId,
      { ticketId, generation: 1, statusUrl: `/v1/tickets/${ticketId}` },
    ],
  );
  return client;
}

test('concurrent equal submissions wait on database uniqueness and share one receipt', async () => {
  await migrator.query(
    'CREATE FUNCTION lab.fixture_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(41017,20); RETURN NEW; END $$',
  );
  await migrator.query(
    'CREATE TRIGGER fixture_wait AFTER INSERT ON lab.tickets FOR EACH ROW EXECUTE FUNCTION lab.fixture_wait()',
  );
  await admin.query('SELECT pg_advisory_lock(41017,20)');
  let pending = [];
  try {
    pending = Array.from({ length: 8 }, () => store().submit(input()));
    const settled = Promise.allSettled(pending);
    await waitForLock('advisory');
    await waitForLock('transactionid');
    await admin.query('SELECT pg_advisory_unlock(41017,20)');
    const results = await settled;
    expect(results.every((entry) => entry.status === 'fulfilled')).toBe(true);
    for (const result of results)
      expect(result.value).toEqual(results[0].value);
    expect(await counts()).toEqual([1, 1, 1, 1]);
  } finally {
    await admin.query('SELECT pg_advisory_unlock(41017,20)');
    await Promise.allSettled(pending);
    await migrator.query(
      'DROP TRIGGER fixture_wait ON lab.tickets; DROP FUNCTION lab.fixture_wait()',
    );
  }
});

test('concurrent changed input yields one winner and one conflict', async () => {
  const results = await Promise.allSettled([
    store().submit(input()),
    store().submit(input({ body: { message: 'Different question' } })),
  ]);
  expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(
    1,
  );
  expect(results.find((entry) => entry.status === 'rejected').reason.code).toBe(
    'IDEMPOTENCY_CONFLICT',
  );
  expect(await counts()).toEqual([1, 1, 1, 1]);
});

test('trim-equivalent retries preserve the original receipt and event request identity', async () => {
  const command = input();
  const receipt = await store().submit(command);
  const retry = input({
    principalId: operator,
    body: { message: '\t Fictional support question \n' },
  });
  expect(await store().submit(retry)).toEqual(receipt);
  const event = JSON.parse(
    (await migrator.query('SELECT payload FROM lab.outbox_events')).rows[0]
      .payload,
  );
  expect(event.correlationId).toBe(command.requestId);
  expect(await counts()).toEqual([1, 1, 1, 1]);
});

test.each(['fictional support question', 'Fictional  support question'])(
  'case/interior whitespace changes conflict: %s',
  async (message) => {
    await store().submit(input());
    await expect(
      store().submit(input({ body: { message } })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await counts()).toEqual([1, 1, 1, 1]);
  },
);

test('tenant scope and case-sensitive keys are independent', async () => {
  const first = await store().submit(input({ key: 'Case-key' }));
  const second = await store().submit(input({ key: 'case-key' }));
  const third = await store().submit(
    input({
      tenantId: otherTenant,
      principalId: otherPrincipal,
      key: 'Case-key',
    }),
  );
  expect(new Set([first.ticketId, second.ticketId, third.ticketId]).size).toBe(
    3,
  );
  expect(await counts()).toEqual([3, 3, 3, 3]);
});

test.each([
  { message: '' },
  { message: '  \t\n' },
  { message: 'x'.repeat(4001) },
  { message: '\u0000' },
  { message: '\ud800' },
  { message: 'valid', tenantId: otherTenant },
  { message: 12 },
])(
  'invalid body neither reserves a key nor writes business data: %j',
  async (body) => {
    await expect(store().submit(input({ body }))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(await counts()).toEqual([0, 0, 0, 0]);
    await expect(store().submit(input())).resolves.toHaveProperty(
      'generation',
      1,
    );
  },
);

test('the Unicode limit counts code points and preserves Unicode normalization', async () => {
  await store().submit(input({ body: { message: '😀'.repeat(4000) } }));
  expect(
    (
      await migrator.query(
        'SELECT char_length(message) AS length FROM lab.tickets',
      )
    ).rows[0].length,
  ).toBe(4000);
  await store().submit(input({ key: 'unicode', body: { message: 'é' } }));
  await expect(
    store().submit(input({ key: 'unicode', body: { message: 'e\u0301' } })),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

test.each(['bad key', '', 'a'.repeat(129)])(
  'invalid idempotency key reserves nothing',
  async (key) => {
    await expect(store().submit(input({ key }))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  },
);

test('reader, other-tenant membership and disabled-principal retries cannot mutate or retrieve receipts', async () => {
  await expect(
    store().submit(input({ principalId: reader })),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    store().submit(input({ principalId: otherPrincipal })),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const command = input();
  await store().submit(command);
  await migrator.query(
    'UPDATE lab.principals SET disabled_at=CURRENT_TIMESTAMP WHERE id=$1',
    [principal],
  );
  await expect(store().submit(command)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(await counts()).toEqual([1, 1, 1, 1]);
});

test.each([
  'idempotency_records',
  'tickets',
  'ticket_executions',
  'outbox_events',
])(
  'a failure after inserting %s rolls back every submission row',
  async (table) => {
    await migrator.query(
      "CREATE FUNCTION lab.fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-secret-in-sql'; END $$",
    );
    await migrator.query(
      `CREATE TRIGGER fixture_fail AFTER INSERT ON lab.${table} FOR EACH ROW EXECUTE FUNCTION lab.fixture_fail()`,
    );
    try {
      await expect(store().submit(input())).rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'DEPENDENCY_UNAVAILABLE',
      });
      expect(await counts()).toEqual([0, 0, 0, 0]);
    } finally {
      await migrator.query(
        `DROP TRIGGER fixture_fail ON lab.${table}; DROP FUNCTION lab.fixture_fail()`,
      );
    }
    await expect(store().submit(input())).resolves.toHaveProperty(
      'generation',
      1,
    );
  },
);

test('a rolled-back concurrent reservation does not consume the key', async () => {
  const held = await reservation();
  const pending = store().submit(input());
  const settled = Promise.allSettled([pending]);
  try {
    await waitForLock('transactionid');
    await held.query('ROLLBACK');
    await expect(pending).resolves.toHaveProperty('generation', 1);
    expect(await counts()).toEqual([1, 1, 1, 1]);
  } finally {
    await held.query('ROLLBACK');
    held.release();
    await settled;
  }
});

test('unresolved uniqueness contention returns a bounded safe error and remains retryable', async () => {
  const held = await reservation();
  try {
    await expect(store().submit(input())).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  } finally {
    await held.query('ROLLBACK');
    held.release();
  }
  await expect(store().submit(input())).resolves.toHaveProperty(
    'generation',
    1,
  );
});

test('a lost commit acknowledgement returns a safe error and retry observes committed receipt', async () => {
  let loseCommitAck = true;
  const connection = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (text === 'COMMIT' && loseCommitAck) {
            loseCommitAck = false;
            throw new Error('fixture-private-network-detail');
          }
          return result;
        },
        release(discard) {
          client.release(discard);
        },
      };
    },
  };
  const command = input();
  await expect(store(connection).submit(command)).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'DEPENDENCY_UNAVAILABLE',
  });
  expect(await counts()).toEqual([1, 1, 1, 1]);
  const original = (
    await migrator.query('SELECT receipt FROM lab.idempotency_records')
  ).rows[0].receipt;
  expect(await store().submit(command)).toEqual(original);
  expect(await counts()).toEqual([1, 1, 1, 1]);
});
