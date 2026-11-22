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
let container, admin, migrator, pool, relayPool, workerPool;

test('admission durably schedules one job and an inbox identity for a submitted ticket', async () => {
  const {
    SchedulingAdmissions,
  } = require('../../apps/worker/dist/scheduling-admissions.js');
  await store().submit(input());
  const row = (
    await migrator.query(
      'SELECT ticket_id,event_id,payload FROM lab.outbox_events',
    )
  ).rows[0];
  const result = await new SchedulingAdmissions(workerPool).admit({
    topic: 'tickets.execution-requested.v1',
    partition: 0,
    offset: '0',
    key: Buffer.from(row.ticket_id),
    value: Buffer.from(row.payload),
  });
  expect(result).toEqual({ disposition: 'scheduled' });
  expect(
    (
      await migrator.query(
        'SELECT disposition,event_id FROM lab.consumer_inbox',
      )
    ).rows,
  ).toEqual([{ disposition: 'scheduled', event_id: row.event_id }]);
  expect(
    (
      await migrator.query(
        'SELECT ticket_id,source_event_id,attempt_count,max_attempts,status FROM lab.execution_jobs',
      )
    ).rows,
  ).toEqual([
    {
      ticket_id: row.ticket_id,
      source_event_id: row.event_id,
      attempt_count: 0,
      max_attempts: 3,
      status: 'queued',
    },
  ]);
});
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
  const relayLogin = `fixture_relay_${randomBytes(4).toString('hex')}`;
  const relayPassword = randomBytes(32).toString('base64url');
  await admin.query(
    `CREATE ROLE ${escapeIdentifier(relayLogin)} LOGIN NOINHERIT PASSWORD ${escapeLiteral(relayPassword)}`,
  );
  await admin.query(`GRANT lab_relay TO ${escapeIdentifier(relayLogin)}`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${escapeIdentifier(configuration.database)} TO ${escapeIdentifier(relayLogin)}`,
  );
  relayPool = new Pool({
    ...configuration,
    user: relayLogin,
    password: relayPassword,
    max: 4,
    application_name: 'outbox-relay-test',
  });
  const workerLogin = `fixture_worker_${randomBytes(4).toString('hex')}`;
  const workerPassword = randomBytes(32).toString('base64url');
  await admin.query(
    `CREATE ROLE ${escapeIdentifier(workerLogin)} LOGIN NOINHERIT PASSWORD ${escapeLiteral(workerPassword)}`,
  );
  await admin.query(`GRANT lab_worker TO ${escapeIdentifier(workerLogin)}`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${escapeIdentifier(configuration.database)} TO ${escapeIdentifier(workerLogin)}`,
  );
  workerPool = new Pool({
    ...configuration,
    user: workerLogin,
    password: workerPassword,
    max: 4,
    application_name: 'scheduling-admission-test',
  });
}, 180000);
afterEach(async () => {
  await migrator.query(
    'TRUNCATE lab.execution_attempts, lab.execution_jobs, lab.consumer_inbox, lab.event_quarantine, lab.idempotency_records, lab.outbox_events, lab.ticket_executions, lab.tickets',
  );
  await migrator.query('UPDATE lab.principals SET disabled_at=NULL');
});
afterAll(async () => {
  await workerPool?.end();
  await relayPool?.end();
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

test('the relay can durably reserve one pending event without marking it published', async () => {
  await store().submit(input());
  const {
    OutboxPublications,
  } = require('../../apps/worker/dist/outbox-publications.js');
  const publications = new OutboxPublications(relayPool);
  const claims = await publications.claim(20);
  expect(claims).toHaveLength(1);
  expect(
    (await migrator.query('SELECT published_at FROM lab.outbox_events')).rows[0]
      .published_at,
  ).toBeNull();
});

test.each([0, -1, 21, 1.5, NaN])(
  'unbounded or invalid relay batch size %s is rejected before claiming',
  async (limit) => {
    expect(() => publications().claim(limit)).toThrow('INVALID_REQUEST');
  },
);
test('lease validity is checked after acquiring a row lock, including an unchanged locked row', async () => {
  await store().submit(input());
  const source = publications();
  const [claim] = await source.claim();
  await migrator.query(
    "UPDATE lab.outbox_events SET claim_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE event_id=$1",
    [claim.eventId],
  );
  await migrator.query('BEGIN');
  await migrator.query(
    'SELECT event_id FROM lab.outbox_events WHERE event_id=$1 FOR UPDATE',
    [claim.eventId],
  );
  const pending = source.acknowledge(claim.eventId, claim.token);
  const settled = Promise.allSettled([pending]);
  try {
    const deadline = performance.now() + 1500;
    let blocked = false,
      hasExpired = false;
    while (performance.now() < deadline) {
      blocked ||=
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='outbox-relay-test' AND wait_event_type='Lock'",
          )
        ).rows[0].count > 0;
      hasExpired = (
        await admin.query(
          'SELECT claim_expires_at<=clock_timestamp() AS expired FROM lab.outbox_events WHERE event_id=$1',
          [claim.eventId],
        )
      ).rows[0].expired;
      if (blocked && hasExpired) break;
      await delay(20);
    }
    expect(blocked).toBe(true);
    expect(hasExpired).toBe(true);
    await migrator.query('COMMIT');
    expect(await pending).toBe(false);
    expect(
      (await migrator.query('SELECT published_at FROM lab.outbox_events'))
        .rows[0].published_at,
    ).toBeNull();
  } finally {
    await migrator.query('ROLLBACK');
    await settled;
  }
});
test('losing SQL commit acknowledgement cannot reactivate a published event', async () => {
  await store().submit(input());
  const source = publications();
  const [claim] = await source.claim();
  let lose = true;
  const poolProxy = {
    async connect() {
      const client = await relayPool.connect();
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (text === 'COMMIT' && lose) {
            lose = false;
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
  const {
    OutboxPublications,
  } = require('../../apps/worker/dist/outbox-publications.js');
  await expect(
    new OutboxPublications(poolProxy).acknowledge(claim.eventId, claim.token),
  ).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'DEPENDENCY_UNAVAILABLE',
  });
  expect(
    (await migrator.query('SELECT published_at FROM lab.outbox_events')).rows[0]
      .published_at,
  ).toBeInstanceOf(Date);
  expect(await source.retry(claim.eventId, claim.token)).toBe(false);
  expect(await source.claim()).toEqual([]);
});
function publications() {
  const {
    OutboxPublications,
  } = require('../../apps/worker/dist/outbox-publications.js');
  return new OutboxPublications(relayPool);
}

function admissions(source = workerPool) {
  const {
    SchedulingAdmissions,
  } = require('../../apps/worker/dist/scheduling-admissions.js');
  return new SchedulingAdmissions(source);
}
async function schedulingRecord(command = {}) {
  const receipt = await store().submit(
    input({ key: randomUUID(), ...command }),
  );
  const row = (
    await migrator.query(
      'SELECT payload FROM lab.outbox_events WHERE ticket_id=$1',
      [receipt.ticketId],
    )
  ).rows[0];
  return {
    topic: 'tickets.execution-requested.v1',
    partition: 0,
    offset: '0',
    key: Buffer.from(receipt.ticketId),
    value: Buffer.from(row.payload),
  };
}
const changedEvent = (record, fields, offset = '1') => ({
  ...record,
  offset,
  value: Buffer.from(
    JSON.stringify({ ...JSON.parse(record.value), ...fields }),
  ),
});
async function admissionCounts() {
  const values = [];
  for (const name of ['consumer_inbox', 'execution_jobs', 'event_quarantine'])
    values.push(
      (await migrator.query(`SELECT count(*)::int AS n FROM lab.${name}`))
        .rows[0].n,
    );
  return values;
}
test('concurrent redelivery of one event commits one inbox identity and one job', async () => {
  const record = await schedulingRecord();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      admissions().admit({ ...record, offset: String(i) }),
    ),
  );
  expect(results.filter((r) => r.disposition === 'scheduled')).toHaveLength(1);
  expect(results.filter((r) => r.disposition === 'duplicate')).toHaveLength(7);
  expect(await admissionCounts()).toEqual([1, 1, 0]);
});
test('different concurrent event identities for one generation retain every inbox identity but one job', async () => {
  const record = await schedulingRecord();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      admissions().admit(
        changedEvent(record, { eventId: randomUUID() }, String(i)),
      ),
    ),
  );
  expect(results.filter((r) => r.disposition === 'scheduled')).toHaveLength(1);
  expect(
    results.filter((r) => r.disposition === 'duplicate-generation'),
  ).toHaveLength(7);
  expect(await admissionCounts()).toEqual([8, 1, 0]);
});
test('changed bytes under an admitted event ID are quarantined instead of treated as a duplicate', async () => {
  const record = await schedulingRecord();
  await admissions().admit(record);
  const collision = changedEvent(
    record,
    { harmlessAddition: 'different bytes' },
    '9007199254740993',
  );
  expect(await admissions().admit(collision)).toEqual({
    disposition: 'quarantined',
    reason: 'EVENT_ID_COLLISION',
  });
  expect(await admissions().admit(collision)).toEqual({
    disposition: 'quarantined',
    reason: 'EVENT_ID_COLLISION',
  });
  expect(await admissionCounts()).toEqual([1, 1, 1]);
  expect(
    (
      await migrator.query(
        'SELECT "offset",payload_digest FROM lab.event_quarantine',
      )
    ).rows,
  ).toEqual([
    {
      offset: '9007199254740993',
      payload_digest: createHash('sha256').update(collision.value).digest(),
    },
  ]);
});
test('concurrent event ID reuse across different tickets cannot schedule both tickets', async () => {
  const first = await schedulingRecord(),
    second = await schedulingRecord();
  const collision = changedEvent(second, {
    eventId: JSON.parse(first.value).eventId,
  });
  const results = await Promise.all([
    admissions().admit(first),
    admissions().admit(collision),
  ]);
  expect(results.map((r) => r.disposition).sort()).toEqual([
    'quarantined',
    'scheduled',
  ]);
  expect(await admissionCounts()).toEqual([1, 1, 1]);
});
test.each([
  [{ ticketId: '11111111-1111-4111-8111-111111111111' }, 'UNKNOWN_TICKET'],
  [{ tenantId: '22222222-2222-4222-8222-222222222222' }, 'TENANT_MISMATCH'],
  [{ generation: 2 }, 'FUTURE_GENERATION'],
  [{ data: { reason: 'replayed' } }, 'REASON_MISMATCH'],
])(
  'authoritative state rejects invalid scheduling metadata',
  async (fields, reason) => {
    const record = await schedulingRecord();
    const changed = changedEvent(record, fields);
    if (fields.ticketId) changed.key = Buffer.from(fields.ticketId);
    expect(await admissions().admit(changed)).toEqual({
      disposition: 'quarantined',
      reason,
    });
    expect(await admissionCounts()).toEqual([0, 0, 1]);
    expect(
      (await migrator.query('SELECT status FROM lab.ticket_executions')).rows[0]
        .status,
    ).toBe('queued');
  },
);
test('invalid bytes are durably quarantined without storing raw content or accepting a replacement at that position', async () => {
  const record = await schedulingRecord();
  const invalid = {
    ...record,
    value: Buffer.from('fictional-private-malformed-message'),
    offset: '9223372036854775807',
  };
  const result = { disposition: 'quarantined', reason: 'INVALID_ENVELOPE' };
  expect(await admissions().admit(invalid)).toEqual(result);
  expect(
    await admissions().admit({ ...record, offset: invalid.offset }),
  ).toEqual(result);
  expect(await admissionCounts()).toEqual([0, 0, 1]);
  const columns = (
    await migrator.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='lab' AND table_name='event_quarantine'",
    )
  ).rows.map((r) => r.column_name);
  expect(columns.sort()).toEqual([
    'consumer_name',
    'created_at',
    'offset',
    'partition',
    'payload_digest',
    'reason',
    'topic',
  ]);
});
test('job write failure rolls back its inbox identity and a retry can admit normally', async () => {
  const record = await schedulingRecord();
  await migrator.query(
    "CREATE FUNCTION lab.reject_admission_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-private-admission-detail'; END $$; CREATE TRIGGER reject_admission_job BEFORE INSERT ON lab.execution_jobs FOR EACH ROW EXECUTE FUNCTION lab.reject_admission_job()",
  );
  try {
    await expect(admissions().admit(record)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(await admissionCounts()).toEqual([0, 0, 0]);
  } finally {
    await migrator.query(
      'DROP TRIGGER reject_admission_job ON lab.execution_jobs; DROP FUNCTION lab.reject_admission_job()',
    );
  }
  expect(await admissions().admit(record)).toEqual({
    disposition: 'scheduled',
  });
});
test('a quarantine storage failure cannot resolve as durably handled', async () => {
  const record = { ...(await schedulingRecord()), value: null };
  await migrator.query(
    "CREATE FUNCTION lab.reject_admission_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-private-quarantine-detail'; END $$; CREATE TRIGGER reject_admission_quarantine BEFORE INSERT ON lab.event_quarantine FOR EACH ROW EXECUTE FUNCTION lab.reject_admission_quarantine()",
  );
  try {
    await expect(admissions().admit(record)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(await admissionCounts()).toEqual([0, 0, 0]);
  } finally {
    await migrator.query(
      'DROP TRIGGER reject_admission_quarantine ON lab.event_quarantine; DROP FUNCTION lab.reject_admission_quarantine()',
    );
  }
  expect(await admissions().admit(record)).toEqual({
    disposition: 'quarantined',
    reason: 'INVALID_ENVELOPE',
  });
});
test('lost real commit acknowledgement leaves a durable job that redelivery does not replace', async () => {
  const record = await schedulingRecord();
  let lose = true;
  const proxy = {
    async connect() {
      const client = await workerPool.connect();
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (text === 'COMMIT' && lose) {
            lose = false;
            throw new Error('fixture-private-commit-detail');
          }
          return result;
        },
        release(discard) {
          client.release(discard);
        },
      };
    },
  };
  await expect(admissions(proxy).admit(record)).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
  });
  expect(await admissionCounts()).toEqual([1, 1, 0]);
  const original = (await migrator.query('SELECT id FROM lab.execution_jobs'))
    .rows[0].id;
  expect(await admissions().admit(record)).toEqual({
    disposition: 'duplicate',
  });
  expect(
    (await migrator.query('SELECT id FROM lab.execution_jobs')).rows,
  ).toEqual([{ id: original }]);
});
test('an admission blocked by replay checks the newly committed generation and records the old event as stale', async () => {
  const record = await schedulingRecord();
  const body = JSON.parse(record.value);
  await migrator.query('BEGIN');
  await migrator.query('SELECT id FROM lab.tickets WHERE id=$1 FOR UPDATE', [
    body.ticketId,
  ]);
  const pending = admissions().admit(record);
  const settled = Promise.allSettled([pending]);
  try {
    const deadline = performance.now() + 1500;
    let blocked = false;
    while (performance.now() < deadline) {
      blocked =
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='scheduling-admission-test' AND wait_event_type='Lock'",
          )
        ).rows[0].n > 0;
      if (blocked) break;
      await delay(20);
    }
    expect(blocked).toBe(true);
    const event = {
      ...body,
      eventId: randomUUID(),
      generation: 2,
      data: { reason: 'replayed' },
    };
    const payload = JSON.stringify(event);
    await migrator.query(
      "INSERT INTO lab.ticket_executions(tenant_id,ticket_id,generation,status,scheduling_reason,requested_by,correlation_id,scheduling_event_id) VALUES($1,$2,2,'queued','replayed',$3,$4,$5)",
      [tenant, body.ticketId, principal, body.correlationId, event.eventId],
    );
    await migrator.query(
      "INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest) VALUES($1,$2,$3,2,'ticket.execution.requested',1,$4,$5)",
      [
        event.eventId,
        tenant,
        body.ticketId,
        payload,
        createHash('sha256').update(payload).digest(),
      ],
    );
    await migrator.query(
      'UPDATE lab.tickets SET current_generation=2 WHERE id=$1',
      [body.ticketId],
    );
    await migrator.query('COMMIT');
    expect(await pending).toEqual({ disposition: 'stale' });
    expect(await admissionCounts()).toEqual([1, 0, 0]);
  } finally {
    await migrator.query('ROLLBACK');
    await settled;
  }
});
test('a terminal execution without an existing job is never re-enqueued by delivery', async () => {
  const record = await schedulingRecord();
  await migrator.query("UPDATE lab.ticket_executions SET status='failed'");
  expect(await admissions().admit(record)).toEqual({
    disposition: 'quarantined',
    reason: 'EXECUTION_NOT_QUEUED',
  });
  expect(await admissionCounts()).toEqual([0, 0, 1]);
});
test('worker admission privileges deny ticket content/pointer changes and ledger mutation', async () => {
  const record = await schedulingRecord();
  await admissions().admit(record);
  const client = await workerPool.connect();
  try {
    await client.query('SET ROLE lab_worker');
    for (const sql of [
      'SELECT message FROM lab.tickets',
      'SELECT secret_digest FROM lab.auth_credentials',
      'UPDATE lab.tickets SET current_generation=2',
      'SELECT payload FROM lab.outbox_events',
      'DELETE FROM lab.consumer_inbox',
      "UPDATE lab.consumer_inbox SET disposition='stale'",
      'DELETE FROM lab.execution_jobs',
      'UPDATE lab.execution_jobs SET source_event_id=gen_random_uuid()',
      'DELETE FROM lab.event_quarantine',
      "UPDATE lab.event_quarantine SET reason='INVALID_ENVELOPE'",
    ])
      await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.query('UPDATE lab.tickets SET id=$1', [randomUUID()]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      client.query(
        'INSERT INTO lab.execution_jobs(id,tenant_id,ticket_id,generation,consumer_name,source_event_id,max_attempts) SELECT id,tenant_id,ticket_id,generation,consumer_name,source_event_id,100 FROM lab.execution_jobs',
      ),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
  expect(await admissionCounts()).toEqual([1, 1, 0]);
});
test('a second event cannot replace an existing job after its execution becomes terminal', async () => {
  const record = await schedulingRecord();
  await admissions().admit(record);
  const original = (
    await migrator.query('SELECT id,source_event_id FROM lab.execution_jobs')
  ).rows;
  await migrator.query("UPDATE lab.ticket_executions SET status='failed'");
  expect(
    await admissions().admit(changedEvent(record, { eventId: randomUUID() })),
  ).toEqual({ disposition: 'duplicate-generation' });
  expect(
    (await migrator.query('SELECT id,source_event_id FROM lab.execution_jobs'))
      .rows,
  ).toEqual(original);
  expect(await admissionCounts()).toEqual([2, 1, 0]);
});
test('job references cannot combine one admitted event with a different tenant execution', async () => {
  const first = await schedulingRecord();
  const second = await schedulingRecord({
    tenantId: otherTenant,
    principalId: otherPrincipal,
  });
  await admissions().admit(first);
  const client = await workerPool.connect();
  try {
    await client.query('SET ROLE lab_worker');
    await expect(
      client.query(
        'INSERT INTO lab.execution_jobs(id,tenant_id,ticket_id,generation,consumer_name,source_event_id) VALUES($1,$2,$3,1,$4,$5)',
        [
          randomUUID(),
          otherTenant,
          JSON.parse(second.value).ticketId,
          'ticket-scheduler.v1',
          JSON.parse(first.value).eventId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
  expect(await admissionCounts()).toEqual([1, 1, 0]);
});
function relay(publisher, source = publications()) {
  const { OutboxRelay } = require('../../apps/worker/dist/outbox-relay.js');
  return new OutboxRelay(source, publisher);
}
async function expired(eventId) {
  await migrator.query(
    "UPDATE lab.outbox_events SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
    [eventId],
  );
}
async function eligible(eventId) {
  await migrator.query(
    "UPDATE lab.outbox_events SET available_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
    [eventId],
  );
}

test('concurrent relay claims are disjoint and skip a row locked by another process', async () => {
  for (let i = 0; i < 5; i++)
    await store().submit(input({ key: `event-${i}` }));
  await migrator.query('BEGIN');
  try {
    const held = (
      await migrator.query(
        'SELECT event_id FROM lab.outbox_events ORDER BY event_id LIMIT 1 FOR UPDATE',
      )
    ).rows[0].event_id;
    const [first, second] = await Promise.all([
      publications().claim(2),
      publications().claim(2),
    ]);
    const ids = [...first, ...second].map((claim) => claim.eventId);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(held);
  } finally {
    await migrator.query('ROLLBACK');
  }
  expect(await publications().claim(20)).toHaveLength(1);
});

test('expired owners cannot acknowledge or reschedule a newer claim', async () => {
  await store().submit(input());
  const source = publications();
  const [old] = await source.claim();
  await expired(old.eventId);
  expect(await source.acknowledge(old.eventId, old.token)).toBe(false);
  const [current] = await source.claim();
  expect(current.eventId).toBe(old.eventId);
  expect(current.token).not.toBe(old.token);
  expect(await source.retry(old.eventId, old.token)).toBe(false);
  expect(await source.acknowledge(old.eventId, old.token)).toBe(false);
  expect(await source.acknowledge(current.eventId, current.token)).toBe(true);
  const row = (
    await migrator.query(
      'SELECT publication_attempts,claim_token,claim_expires_at,published_at FROM lab.outbox_events',
    )
  ).rows[0];
  expect(row.publication_attempts).toBe(2);
  expect(row.claim_token).toBeNull();
  expect(row.claim_expires_at).toBeNull();
  expect(row.published_at).toBeInstanceOf(Date);
  expect(await source.claim()).toEqual([]);
});

test('publication happens outside SQL transactions and is marked only after the publisher resolves', async () => {
  await store().submit(input());
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const sent = new Promise((resolve) => {
    release = resolve;
  });
  let message;
  const pending = relay({
    async publish(value) {
      message = value;
      started();
      await sent;
    },
  }).publishBatch();
  await ready;
  try {
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='outbox-relay-test' AND xact_start IS NOT NULL",
        )
      ).rows[0].count,
    ).toBe(0);
    const row = (await migrator.query('SELECT * FROM lab.outbox_events'))
      .rows[0];
    expect(row.published_at).toBeNull();
    expect(row.claim_token).not.toBeNull();
    expect(message).toEqual({
      topic: 'tickets.execution-requested.v1',
      key: row.ticket_id,
      value: row.payload,
      eventId: row.event_id,
    });
    expect(await publications().claim()).toEqual([]);
  } finally {
    release();
  }
  expect(await pending).toMatchObject({
    claimed: 1,
    published: 1,
    retryable: 0,
    stale: 0,
  });
});

test('a publisher failure retains immutable bytes and schedules bounded retry without leaking its error', async () => {
  await store().submit(input());
  const before = (
    await migrator.query(
      'SELECT event_id,payload,payload_digest FROM lab.outbox_events',
    )
  ).rows[0];
  expect(
    await relay({
      async publish() {
        throw new Error('fixture-private-provider-detail');
      },
    }).publishBatch(),
  ).toMatchObject({ published: 0, retryable: 1 });
  const after = (await migrator.query('SELECT * FROM lab.outbox_events'))
    .rows[0];
  expect(after.payload).toBe(before.payload);
  expect(after.payload_digest).toEqual(before.payload_digest);
  expect(after.published_at).toBeNull();
  expect(after.last_error_code).toBe('PUBLISH_FAILED');
  expect(after.claim_token).toBeNull();
  expect(await publications().claim()).toEqual([]);
  await eligible(before.event_id);
  const received = [];
  expect(
    await relay({
      async publish(message) {
        received.push(message);
      },
    }).publishBatch(),
  ).toMatchObject({ published: 1 });
  expect(received[0].value).toBe(before.payload);
  expect(received[0].eventId).toBe(before.event_id);
});

test('a crash after publisher acceptance before SQL marking may repeat delivery but preserves event identity', async () => {
  await store().submit(input());
  const source = publications();
  const [first] = await source.claim();
  const accepted = [first.payload]; // Controlled accepted-message checkpoint, not a broker acknowledgement claim.
  await expired(first.eventId);
  await relay({
    async publish(message) {
      accepted.push(message.value);
    },
  }).publishBatch();
  expect(accepted).toEqual([first.payload, first.payload]);
  expect(
    (await migrator.query('SELECT publication_attempts FROM lab.outbox_events'))
      .rows[0].publication_attempts,
  ).toBe(2);
});

test('late publisher completion cannot mark a claim that another relay reclaimed', async () => {
  await store().submit(input());
  const source = publications();
  let replacement;
  const result = await relay(
    {
      async publish(message) {
        await expired(message.eventId);
        [replacement] = await source.claim();
      },
    },
    source,
  ).publishBatch();
  expect(result).toMatchObject({ published: 0, stale: 1 });
  const row = (
    await migrator.query(
      'SELECT claim_token,published_at FROM lab.outbox_events',
    )
  ).rows[0];
  expect(row.claim_token).toBe(replacement.token);
  expect(row.published_at).toBeNull();
});

test('corrupt stored digest is not published and persists only an allowlisted failure code', async () => {
  await store().submit(input());
  await migrator.query('UPDATE lab.outbox_events SET payload_digest=$1', [
    randomBytes(32),
  ]);
  let published = false;
  expect(
    await relay({
      async publish() {
        published = true;
      },
    }).publishBatch(),
  ).toMatchObject({ retryable: 1, published: 0 });
  expect(published).toBe(false);
  expect(
    (await migrator.query('SELECT last_error_code FROM lab.outbox_events'))
      .rows[0].last_error_code,
  ).toBe('INVALID_EVENT');
});

test('relay role cannot alter event content, delete events or read ticket messages', async () => {
  await store().submit(input());
  for (const sql of [
    "UPDATE lab.outbox_events SET payload='{}'",
    'DELETE FROM lab.outbox_events',
    'SELECT message FROM lab.tickets',
  ]) {
    const client = await relayPool.connect();
    try {
      await client.query('BEGIN; SET LOCAL ROLE lab_relay');
      await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
});

function store(source = pool) {
  const {
    TicketSubmissions,
  } = require('../../apps/api/dist/ticket-submission.js');
  return new TicketSubmissions(source);
}
function reads() {
  const { TicketReads } = require('../../apps/api/dist/ticket-read.js');
  return new TicketReads(pool);
}
test('a same-tenant reader sees only the current queued status and no internal or message fields', async () => {
  const receipt = await store().submit(input());
  const result = await reads().get({
    tenantId: tenant,
    principalId: reader,
    ticketId: receipt.ticketId,
  });
  expect(result).toEqual({
    ticketId: receipt.ticketId,
    generation: 1,
    status: 'queued',
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    result: null,
    failure: null,
  });
  expect(Number.isFinite(Date.parse(result.createdAt))).toBe(true);
  expect(await counts()).toEqual([1, 1, 1, 1]);
});
test('foreign and missing ticket IDs have the same non-disclosing result', async () => {
  const receipt = await store().submit(input());
  for (const ticketId of [receipt.ticketId, randomUUID()])
    await expect(
      reads().get({
        tenantId: otherTenant,
        principalId: otherPrincipal,
        ticketId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'NOT_FOUND' });
});
test('read membership and identifier checks cannot be bypassed with caller-provided scope', async () => {
  const receipt = await store().submit(input());
  await expect(
    reads().get({
      tenantId: tenant,
      principalId: otherPrincipal,
      ticketId: receipt.ticketId,
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    reads().get({
      tenantId: tenant,
      principalId: reader,
      ticketId: 'invalid-id',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await migrator.query(
    'UPDATE lab.principals SET disabled_at=CURRENT_TIMESTAMP WHERE id=$1',
    [reader],
  );
  await expect(
    reads().get({
      tenantId: tenant,
      principalId: reader,
      ticketId: receipt.ticketId,
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
test('reads follow the current-generation pointer without returning the previous lifecycle row', async () => {
  const receipt = await store().submit(input());
  const eventId = randomUUID();
  const correlationId = randomUUID();
  const payload = JSON.stringify({
    eventId,
    type: 'ticket.execution.requested',
    version: 1,
    occurredAt: new Date().toISOString(),
    tenantId: tenant,
    ticketId: receipt.ticketId,
    generation: 2,
    correlationId,
    causationId: correlationId,
    data: { reason: 'replayed' },
  });
  await migrator.query('BEGIN');
  try {
    await migrator.query(
      "INSERT INTO lab.ticket_executions(tenant_id,ticket_id,generation,status,scheduling_reason,requested_by,correlation_id,scheduling_event_id) VALUES($1,$2,2,'processing','replayed',$3,$4,$5)",
      [tenant, receipt.ticketId, operator, correlationId, eventId],
    );
    await migrator.query(
      'INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest) VALUES($1,$2,$3,2,$4,1,$5,$6)',
      [
        eventId,
        tenant,
        receipt.ticketId,
        'ticket.execution.requested',
        payload,
        createHash('sha256').update(payload).digest(),
      ],
    );
    await migrator.query(
      'UPDATE lab.tickets SET current_generation=2,updated_at=CURRENT_TIMESTAMP WHERE id=$1',
      [receipt.ticketId],
    );
    await migrator.query('COMMIT');
  } catch (error) {
    await migrator.query('ROLLBACK');
    throw error;
  }
  expect(
    await reads().get({
      tenantId: tenant,
      principalId: reader,
      ticketId: receipt.ticketId,
    }),
  ).toMatchObject({
    generation: 2,
    status: 'processing',
    result: null,
    failure: null,
  });
});
test.each(['completed', 'failed'])(
  'terminal state %s without result storage fails safely instead of fabricating output',
  async (status) => {
    const receipt = await store().submit(input());
    await migrator.query(
      'UPDATE lab.ticket_executions SET status=$1 WHERE ticket_id=$2',
      [status, receipt.ticketId],
    );
    await expect(
      reads().get({
        tenantId: tenant,
        principalId: reader,
        ticketId: receipt.ticketId,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  },
);

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

async function credential(owner = principal) {
  const lookupId = randomUUID();
  const secret = randomBytes(32);
  await migrator.query(
    'INSERT INTO lab.auth_credentials(id,principal_id,secret_digest) VALUES($1,$2,$3)',
    [lookupId, owner, createHash('sha256').update(secret).digest()],
  );
  return {
    lookupId,
    secret: secret.toString('base64url'),
    header: `Bearer ${lookupId}.${secret.toString('base64url')}`,
  };
}
function access() {
  const { TicketAccess } = require('../../apps/api/dist/ticket-access.js');
  return new TicketAccess(pool, { consume: async () => {} });
}

test('opaque bearer authentication resolves the current server-owned tenant and role from stored digest', async () => {
  const token = await credential();
  expect(await access().authenticate(token.header)).toEqual({
    tenantId: tenant,
    principalId: principal,
    role: 'requester',
  });
  expect(
    await access().authenticate(token.header.replace('Bearer', 'bearer')),
  ).toEqual({ tenantId: tenant, principalId: principal, role: 'requester' });
  const other = await credential(otherPrincipal);
  expect(await access().authenticate(other.header)).toEqual({
    tenantId: otherTenant,
    principalId: otherPrincipal,
    role: 'requester',
  });
  const readerToken = await credential(reader);
  expect((await access().authenticate(readerToken.header)).role).toBe('reader');
});

test.each([
  undefined,
  '',
  'Basic invalid',
  'Bearer invalid',
  'Bearer ' + randomUUID() + '.' + 'A'.repeat(42) + 'B',
  'Bearer ' + randomUUID() + '.' + 'A'.repeat(44),
])('malformed credentials fail generically: %s', async (header) => {
  await expect(access().authenticate(header)).rejects.toMatchObject({
    code: 'UNAUTHENTICATED',
    message: 'UNAUTHENTICATED',
  });
  expect(await counts()).toEqual([0, 0, 0, 0]);
});

test('unknown lookup IDs and incorrect secrets receive the same authentication result', async () => {
  const token = await credential();
  await expect(
    access().authenticate(`Bearer ${randomUUID()}.${token.secret}`),
  ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  await expect(
    access().authenticate(
      `Bearer ${token.lookupId}.${randomBytes(32).toString('base64url')}`,
    ),
  ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
});

test.each(['revoked', 'expired', 'disabled'])(
  'credential/principal changes invalidate later authentication without a cache: %s',
  async (state) => {
    const token = await credential();
    const authenticator = access();
    await authenticator.authenticate(token.header);
    if (state === 'revoked')
      await migrator.query(
        'UPDATE lab.auth_credentials SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1',
        [token.lookupId],
      );
    if (state === 'expired')
      await migrator.query(
        "UPDATE lab.auth_credentials SET created_at=CURRENT_TIMESTAMP-interval '2 seconds',expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
        [token.lookupId],
      );
    if (state === 'disabled')
      await migrator.query(
        'UPDATE lab.principals SET disabled_at=CURRENT_TIMESTAMP WHERE id=$1',
        [principal],
      );
    await expect(
      authenticator.authenticate(token.header),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  },
);
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
