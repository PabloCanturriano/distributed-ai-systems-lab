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
const tenant = randomUUID(),
  principal = randomUUID();
let container, admin, migrator, apiPool, workerPool, operationsPool;
beforeAll(async () => {
  const { bootstrapDatabase, migrateDatabase } =
    await import('../../database/dist/index.js');
  container = await new LoopbackPostgreSQL(
    'pgvector/pgvector:0.8.7-pg17-bookworm@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd',
  )
    .withDatabase('execution_ownership_test')
    .withPassword(randomBytes(32).toString('base64url'))
    .withStartupTimeout(120000)
    .start();
  const config = {
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  };
  admin = new Client(config);
  await admin.connect();
  await bootstrapDatabase(admin);
  migrator = new Client(config);
  await migrator.connect();
  await migrator.query('SET ROLE lab_migrator');
  await migrateDatabase(migrator);
  await migrator.query('INSERT INTO lab.tenants(id,name) VALUES($1,$2)', [
    tenant,
    'Fictional executor tenant',
  ]);
  await migrator.query(
    "INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,'requester')",
    [principal, tenant],
  );
  async function login(role) {
    const user = `fixture_${role}_${randomBytes(4).toString('hex')}`,
      password = randomBytes(32).toString('base64url');
    await admin.query(
      `CREATE ROLE ${escapeIdentifier(user)} LOGIN NOINHERIT PASSWORD ${escapeLiteral(password)}`,
    );
    await admin.query(`GRANT lab_${role} TO ${escapeIdentifier(user)}`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${escapeIdentifier(config.database)} TO ${escapeIdentifier(user)}`,
    );
    return new Pool({
      ...config,
      user,
      password,
      max: 4,
      query_timeout: 6000,
      application_name: `execution-${role}-test`,
    });
  }
  apiPool = await login('api');
  workerPool = await login('worker');
  operationsPool = await login('operations');
}, 180000);
afterEach(async () => {
  await migrator.query(
    'TRUNCATE lab.delivery_repairs,lab.audit_records,lab.execution_results,lab.execution_attempts,lab.execution_jobs,lab.consumer_inbox,lab.event_quarantine,lab.idempotency_records,lab.outbox_events,lab.ticket_executions,lab.tickets',
  );
});
afterAll(async () => {
  await operationsPool?.end();
  await workerPool?.end();
  await apiPool?.end();
  await migrator?.end();
  await admin?.end();
  await container?.stop();
});
async function submitted() {
  const {
    TicketSubmissions,
  } = require('../../apps/api/dist/ticket-submission.js');
  return new TicketSubmissions(apiPool).submit({
    tenantId: tenant,
    principalId: principal,
    requestId: randomUUID(),
    key: randomUUID(),
    body: { message: 'Fictional execution question' },
  });
}
async function admitted(replacement = false) {
  const {
    SchedulingAdmissions,
  } = require('../../apps/worker/dist/scheduling-admissions.js');
  const receipt = await submitted();
  const event = (
    await migrator.query(
      'SELECT payload FROM lab.outbox_events WHERE ticket_id=$1',
      [receipt.ticketId],
    )
  ).rows[0];
  let payload = event.payload;
  if (replacement)
    payload = JSON.stringify({ ...JSON.parse(payload), eventId: randomUUID() });
  await new SchedulingAdmissions(workerPool).admit({
    topic: 'tickets.execution-requested.v1',
    partition: 0,
    offset: '0',
    key: Buffer.from(receipt.ticketId),
    value: Buffer.from(payload),
  });
  return (
    await migrator.query(
      'SELECT * FROM lab.execution_jobs WHERE ticket_id=$1',
      [receipt.ticketId],
    )
  ).rows[0];
}
function ownership(source = workerPool) {
  const {
    ExecutionOwnership,
  } = require('../../apps/worker/dist/execution-ownership.js');
  return new ExecutionOwnership(source);
}
const abstention = {
  outcome: 'insufficient_evidence',
  answer: 'No indexed evidence is available in this simulated scenario.',
};
function readTicket(ticketId) {
  const { TicketReads } = require('../../apps/api/dist/ticket-read.js');
  return new TicketReads(apiPool).get({
    tenantId: tenant,
    principalId: principal,
    ticketId,
  });
}

const {
  DeliveryRepairs,
} = require('../../apps/operations/dist/delivery-repairs');
const repairs = (source = operationsPool) => new DeliveryRepairs(source);
async function fixture() {
  const receipt = await submitted();
  const event = (
    await migrator.query(
      'SELECT event_id,payload,payload_digest FROM lab.outbox_events',
    )
  ).rows[0];
  const {
    SchedulingAdmissions,
  } = require('../../apps/worker/dist/scheduling-admissions');
  await new SchedulingAdmissions(workerPool).admit({
    topic: 'tickets.execution-requested.v1',
    partition: 0,
    offset: '0',
    key: Buffer.from(receipt.ticketId),
    value: Buffer.from('private-invalid-source-fixture'),
  });
  return {
    environmentId: (
      await migrator.query('SELECT id FROM lab.environment_identity')
    ).rows[0].id,
    tenantId: tenant,
    ticketId: receipt.ticketId,
    generation: 1,
    expectedEventId: event.event_id,
    source: {
      partition: 0,
      offset: '0',
      digest: createHash('sha256')
        .update('private-invalid-source-fixture')
        .digest('hex'),
    },
    reason: 'DELIVERY_RECOVERY',
    key: randomUUID(),
    requestId: randomUUID(),
  };
}
async function event(id) {
  return (
    await migrator.query('SELECT * FROM lab.outbox_events WHERE event_id=$1', [
      id,
    ])
  ).rows[0];
}
async function admit(value, offset) {
  const {
    SchedulingAdmissions,
  } = require('../../apps/worker/dist/scheduling-admissions');
  return new SchedulingAdmissions(workerPool).admit({
    topic: 'tickets.execution-requested.v1',
    partition: 0,
    offset: String(offset),
    key: Buffer.from(JSON.parse(value.payload).ticketId),
    value: Buffer.from(value.payload),
  });
}
test('safe inspection and planning expose no raw content and perform no mutation', async () => {
  const input = await fixture(),
    inspection = await repairs().inspect();
  expect(inspection.environmentId).toBe(input.environmentId);
  expect(inspection.quarantine).toHaveLength(1);
  expect(inspection.queued).toHaveLength(1);
  expect(JSON.stringify(inspection)).not.toContain('private-invalid');
  expect(JSON.stringify(inspection)).not.toContain(
    'Fictional execution question',
  );
  expect(await repairs().plan(input)).toEqual(input);
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.delivery_repairs',
      )
    ).rows[0].n,
  ).toBe(0);
});
test('canonical same-generation repair commits one event, scoped receipt, pointer and immutable actor/source audit', async () => {
  const input = await fixture(),
    old = await event(input.expectedEventId),
    result = await repairs().repair(input);
  expect(result).toMatchObject({
    ticketId: input.ticketId,
    generation: 1,
    previousEventId: input.expectedEventId,
  });
  expect(result.newEventId).not.toBe(input.expectedEventId);
  expect(await event(input.expectedEventId)).toEqual(old);
  const fresh = await event(result.newEventId),
    payload = JSON.parse(fresh.payload);
  expect(payload).toMatchObject({
    ticketId: input.ticketId,
    generation: 1,
    correlationId: JSON.parse(old.payload).correlationId,
    causationId: input.requestId,
    data: { reason: 'submitted' },
  });
  expect(payload.message).toBeUndefined();
  expect(fresh.payload_digest).toEqual(
    createHash('sha256').update(fresh.payload).digest(),
  );
  const audit = (await migrator.query('SELECT * FROM lab.delivery_repairs'))
    .rows[0];
  expect(audit).toMatchObject({
    previous_event_id: input.expectedEventId,
    new_event_id: result.newEventId,
    source_offset: '0',
    reason: 'DELIVERY_RECOVERY',
    source_digest: Buffer.from(input.source.digest, 'hex'),
    environment_id: input.environmentId,
    request_id: input.requestId,
  });
  expect(audit.actor_database_role).toMatch(/^fixture_operations_/);
  expect(
    (
      await migrator.query(
        'SELECT scheduling_event_id FROM lab.ticket_executions',
      )
    ).rows[0].scheduling_event_id,
  ).toBe(result.newEventId);
  expect(
    (await migrator.query('SELECT current_generation FROM lab.tickets')).rows[0]
      .current_generation,
  ).toBe(1);
  expect(
    (await migrator.query('SELECT count(*)::int AS n FROM lab.execution_jobs'))
      .rows[0].n,
  ).toBe(0);
  expect(await repairs().repair({ ...input, requestId: randomUUID() })).toEqual(
    result,
  );
});
test.each(['same-key', 'different-key'])(
  'concurrent %s repairs serialize at an explicit ticket-lock checkpoint',
  async (mode) => {
    const input = await fixture();
    await migrator.query('BEGIN');
    await migrator.query('SELECT id FROM lab.tickets WHERE id=$1 FOR UPDATE', [
      input.ticketId,
    ]);
    const pending = Promise.allSettled([
      repairs().repair(input),
      repairs().repair({
        ...input,
        key: mode === 'same-key' ? input.key : randomUUID(),
      }),
    ]);
    try {
      const until = performance.now() + 1500;
      let n = 0;
      while (performance.now() < until) {
        n = (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='execution-operations-test' AND wait_event_type='Lock'",
          )
        ).rows[0].n;
        if (n === 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(n).toBe(2);
    } finally {
      await migrator.query('COMMIT');
    }
    const result = await pending;
    if (mode === 'same-key') {
      expect(result.every((x) => x.status === 'fulfilled')).toBe(true);
      expect(result[0].value).toEqual(result[1].value);
    } else {
      expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(result.find((x) => x.status === 'rejected').reason.code).toBe(
        'REPAIR_CONFLICT',
      );
    }
    expect(
      (
        await migrator.query(
          'SELECT count(*)::int AS n FROM lab.delivery_repairs',
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
test.each(['old-first', 'repair-first'])(
  'late delivery %s admits one job and failure causation uses the actual admitted source',
  async (order) => {
    const input = await fixture(),
      result = await repairs().repair(input),
      old = await event(input.expectedEventId),
      fresh = await event(result.newEventId),
      first = order === 'old-first' ? old : fresh,
      last = order === 'old-first' ? fresh : old;
    expect(await admit(first, 1)).toEqual({ disposition: 'scheduled' });
    expect(await admit(last, 2)).toEqual({
      disposition: 'duplicate-generation',
    });
    const claim = await ownership().claim();
    await ownership().fail(claim.jobId, claim.attemptId);
    const failure = JSON.parse(
      (
        await migrator.query(
          "SELECT payload FROM lab.outbox_events WHERE type='ticket.execution.failed'",
        )
      ).rows[0].payload,
    );
    expect(failure.causationId).toBe(first.event_id);
    expect(
      (
        await migrator.query(
          'SELECT count(*)::int AS n FROM lab.execution_jobs',
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await repairs().repair(input)).toEqual(result);
  },
);
test('admission winning the ticket lock prevents a later repair without additional effects', async () => {
  const input = await fixture();
  await admit(await event(input.expectedEventId), 1);
  await expect(repairs().repair(input)).rejects.toMatchObject({
    code: 'REPAIR_CONFLICT',
  });
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.delivery_repairs',
      )
    ).rows[0].n,
  ).toBe(0);
});
test.each(['environment', 'generation', 'event', 'digest', 'missing-source'])(
  'stale or wrong %s fails before any mutation',
  async (kind) => {
    const input = await fixture();
    if (kind === 'environment') input.environmentId = randomUUID();
    if (kind === 'generation') input.generation = 2;
    if (kind === 'event') input.expectedEventId = randomUUID();
    if (kind === 'digest') input.source.digest = 'a'.repeat(64);
    if (kind === 'missing-source') input.source.offset = '99';
    await expect(repairs().repair(input)).rejects.toMatchObject({
      code: kind === 'environment' ? 'ENVIRONMENT_CONFLICT' : 'REPAIR_CONFLICT',
    });
    expect(
      (await migrator.query('SELECT count(*)::int AS n FROM lab.outbox_events'))
        .rows[0].n,
    ).toBe(1);
    expect(
      (
        await migrator.query(
          'SELECT count(*)::int AS n FROM lab.delivery_repairs',
        )
      ).rows[0].n,
    ).toBe(0);
  },
);
test('same key with changed expectations conflicts rather than returning a different repair', async () => {
  const input = await fixture();
  await repairs().repair(input);
  await expect(
    repairs().repair({ ...input, reason: 'SOURCE_CORRECTED' }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
function proxy(trigger, after = true) {
  return {
    connect: async () => {
      const c = await operationsPool.connect();
      return {
        release: (v) => c.release(v),
        query: async (sql, args) => {
          if (!after && trigger(sql)) throw new Error('private-fixture');
          const value = await c.query(sql, args);
          if (after && trigger(sql)) throw new Error('private-fixture');
          return value;
        },
      };
    },
  };
}
test('an error after the pointer update rolls back all repair effects', async () => {
  const input = await fixture();
  await expect(
    repairs(
      proxy((sql) => sql.startsWith('UPDATE lab.ticket_executions')),
    ).repair(input),
  ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  expect(
    (
      await migrator.query(
        'SELECT scheduling_event_id FROM lab.ticket_executions',
      )
    ).rows[0].scheduling_event_id,
  ).toBe(input.expectedEventId);
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.idempotency_records WHERE operation=$1',
        ['tickets:delivery-repair:v1'],
      )
    ).rows[0].n,
  ).toBe(0);
});
test('same-key retry resolves a lost repair COMMIT reply', async () => {
  const input = await fixture();
  await expect(
    repairs(proxy((sql) => sql === 'COMMIT')).repair(input),
  ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  const result = await repairs().repair(input);
  expect(result.previousEventId).toBe(input.expectedEventId);
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.delivery_repairs',
      )
    ).rows[0].n,
  ).toBe(1);
});
test('operations authority cannot inspect messages/credentials or create work, change lifecycle, delete history or escalate', async () => {
  await fixture();
  const c = await operationsPool.connect();
  try {
    await c.query('SET ROLE lab_operations');
    for (const sql of [
      'SELECT message FROM lab.tickets',
      'SELECT secret_digest FROM lab.auth_credentials',
      'SELECT payload FROM lab.outbox_events',
      "UPDATE lab.ticket_executions SET status='completed'",
      'UPDATE lab.tickets SET current_generation=2',
      'DELETE FROM lab.event_quarantine',
      'DELETE FROM lab.delivery_repairs',
      "UPDATE lab.delivery_repairs SET reason='SCHEMA_CORRECTED'",
      'UPDATE lab.environment_identity SET id=gen_random_uuid()',
      'SET ROLE lab_migrator',
      'SET ROLE lab_api',
      'INSERT INTO lab.execution_jobs(id) VALUES(gen_random_uuid())',
      'SET ROLE lab_worker',
      'CREATE TABLE lab.forbidden(id int)',
    ])
      await expect(c.query(sql)).rejects.toMatchObject({ code: '42501' });
  } finally {
    c.release(true);
  }
});

test('a foreign tenant cannot plan or apply repair for another tenant ticket', async () => {
  const input = await fixture();
  for (const action of ['plan', 'repair'])
    await expect(
      repairs()[action]({ ...input, tenantId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.delivery_repairs',
      )
    ).rows[0].n,
  ).toBe(0);
});
test('repair and original admission race behind an observed ticket lock without duplicating work', async () => {
  const input = await fixture(),
    original = await event(input.expectedEventId);
  await migrator.query('BEGIN');
  await migrator.query('SELECT id FROM lab.tickets WHERE id=$1 FOR UPDATE', [
    input.ticketId,
  ]);
  const pending = Promise.allSettled([
    repairs().repair(input),
    admit(original, '1'),
  ]);
  try {
    const until = performance.now() + 1500;
    let n = 0;
    while (performance.now() < until) {
      n = (
        await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name IN ('execution-operations-test','execution-worker-test') AND wait_event_type='Lock'",
        )
      ).rows[0].n;
      if (n === 2) break;
      await delay(10);
    }
    expect(n).toBe(2);
  } finally {
    await migrator.query('COMMIT');
  }
  const [repair, admission] = await pending;
  expect(admission.status).toBe('fulfilled');
  if (repair.status === 'rejected')
    expect(repair.reason.code).toBe('REPAIR_CONFLICT');
  else await admit(await event(repair.value.newEventId), '2');
  const jobs = (
    await migrator.query('SELECT source_event_id FROM lab.execution_jobs')
  ).rows;
  expect(jobs).toEqual([{ source_event_id: input.expectedEventId }]);
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.delivery_repairs',
      )
    ).rows[0].n,
  ).toBe(repair.status === 'fulfilled' ? 1 : 0);
});
