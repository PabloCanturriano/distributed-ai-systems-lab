const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { Client, Pool, escapeIdentifier, escapeLiteral } = require('pg');
const { randomBytes, randomUUID, createHash } = require('node:crypto');

class LoopbackPostgreSQL extends PostgreSqlContainer {
  async beforeContainerCreated() {
    this.hostConfig.PortBindings['5432/tcp'] = [
      { HostIp: '127.0.0.1', HostPort: '0' },
    ];
  }
}
const tenant = randomUUID(),
  principal = randomUUID();
let container, admin, migrator, apiPool, workerPool;
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
    'Fictional replay tenant',
  ]);
  await require('./knowledge-fixture.cjs').seedEmptyCorpus(migrator, tenant);
  await migrator.query(
    "INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,'operator')",
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
}, 180000);
afterEach(async () => {
  await migrator.query(
    'TRUNCATE lab.result_citations,lab.execution_evidence,lab.execution_configurations,lab.delivery_repairs,lab.audit_records,lab.execution_results,lab.execution_attempts,lab.execution_jobs,lab.consumer_inbox,lab.event_quarantine,lab.idempotency_records,lab.outbox_events,lab.ticket_executions,lab.tickets',
  );
});
afterAll(async () => {
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

const { TicketReplays } = require('../../apps/api/dist/ticket-replay');
function replay(ticketId, changes = {}) {
  return new TicketReplays(apiPool).replay({
    tenantId: tenant,
    principalId: principal,
    ticketId,
    requestId: randomUUID(),
    key: randomUUID(),
    body: { expectedGeneration: 1 },
    ...changes,
  });
}
async function failed() {
  const job = await admitted();
  const claim = await ownership().claim();
  expect(await ownership().fail(claim.jobId, claim.attemptId)).toBe(true);
  return { job, claim };
}
async function counts() {
  const r = await migrator.query(
    `SELECT (SELECT count(*)::int FROM lab.ticket_executions) AS executions,(SELECT count(*)::int FROM lab.idempotency_records WHERE operation='tickets:replay:v1') AS receipts,(SELECT count(*)::int FROM lab.audit_records) AS audits,(SELECT count(*)::int FROM lab.outbox_events WHERE type='ticket.execution.requested') AS events`,
  );
  return r.rows[0];
}
test('a failed execution replays atomically, retains history and returns current queued state', async () => {
  const { job } = await failed(),
    requestId = randomUUID();
  const original = (
    await migrator.query(
      'SELECT * FROM lab.ticket_executions WHERE ticket_id=$1',
      [job.ticket_id],
    )
  ).rows[0];
  const result = await replay(job.ticket_id, { requestId });
  expect(result).toEqual({
    ticketId: job.ticket_id,
    generation: 2,
    statusUrl: `/v1/tickets/${job.ticket_id}`,
  });
  expect(await counts()).toEqual({
    executions: 2,
    receipts: 1,
    audits: 1,
    events: 2,
  });
  const rows = (
    await migrator.query(
      'SELECT * FROM lab.ticket_executions ORDER BY generation',
    )
  ).rows;
  expect(rows[0]).toEqual(original);
  expect(rows[1]).toMatchObject({
    generation: 2,
    status: 'queued',
    scheduling_reason: 'replayed',
    requested_by: principal,
    correlation_id: requestId,
  });
  const audit = (await migrator.query('SELECT * FROM lab.audit_records'))
    .rows[0];
  expect(audit).toMatchObject({
    tenant_id: tenant,
    principal_id: principal,
    ticket_id: job.ticket_id,
    generation: 2,
    previous_generation: 1,
    action: 'ticket.replayed',
    request_id: requestId,
  });
  const event = (
    await migrator.query(
      'SELECT payload,payload_digest FROM lab.outbox_events WHERE generation=2',
    )
  ).rows[0];
  expect(JSON.parse(event.payload)).toMatchObject({
    ticketId: job.ticket_id,
    generation: 2,
    correlationId: requestId,
    causationId: requestId,
    data: { reason: 'replayed' },
  });
  expect(event.payload_digest).toEqual(
    createHash('sha256').update(event.payload).digest(),
  );
  expect(await readTicket(job.ticket_id)).toMatchObject({
    generation: 2,
    status: 'queued',
    result: null,
    failure: null,
  });
  expect(
    (
      await migrator.query(
        'SELECT status,failure_code FROM lab.execution_jobs WHERE generation=1',
      )
    ).rows[0],
  ).toEqual({ status: 'failed', failure_code: 'EXECUTION_FAILED' });
});
async function competing(ticketId, calls) {
  await migrator.query('BEGIN');
  await migrator.query('SELECT id FROM lab.tickets WHERE id=$1 FOR UPDATE', [
    ticketId,
  ]);
  const settled = Promise.allSettled(calls.map((call) => call()));
  try {
    const until = performance.now() + 1500;
    let blocked = 0;
    while (performance.now() < until) {
      blocked = (
        await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='execution-api-test' AND wait_event_type='Lock' AND query LIKE 'SELECT current_generation FROM lab.tickets%'",
        )
      ).rows[0].n;
      if (blocked === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(2);
  } finally {
    await migrator.query('COMMIT');
  }
  return settled;
}
test('different concurrent keys at the same generation produce one replay and one conflict', async () => {
  const { job } = await failed();
  const results = await competing(job.ticket_id, [
    () => replay(job.ticket_id),
    () => replay(job.ticket_id),
  ]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((x) => x.status === 'rejected').reason.code).toBe(
    'REPLAY_CONFLICT',
  );
  expect(await counts()).toEqual({
    executions: 2,
    receipts: 1,
    audits: 1,
    events: 2,
  });
});
test('concurrent identical keys return the same receipt without another event or audit', async () => {
  const { job } = await failed(),
    key = randomUUID();
  const results = await competing(job.ticket_id, [
    () => replay(job.ticket_id, { key }),
    () => replay(job.ticket_id, { key }),
  ]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(results[0].value).toEqual(results[1].value);
  expect(await counts()).toEqual({
    executions: 2,
    receipts: 1,
    audits: 1,
    events: 2,
  });
});
test('receipt retries precede lifecycle checks even after the new generation completes', async () => {
  const { job, claim: old } = await failed(),
    key = randomUUID();
  const receipt = await replay(job.ticket_id, { key });
  const event = (
    await migrator.query(
      'SELECT payload FROM lab.outbox_events WHERE generation=2',
    )
  ).rows[0];
  const {
    SchedulingAdmissions,
  } = require('../../apps/worker/dist/scheduling-admissions');
  await new SchedulingAdmissions(workerPool).admit({
    topic: 'tickets.execution-requested.v1',
    partition: 0,
    offset: '2',
    key: Buffer.from(job.ticket_id),
    value: Buffer.from(event.payload),
  });
  const claim = await ownership().claim();
  expect(claim.generation).toBe(2);
  expect(
    await ownership().complete(claim.jobId, claim.attemptId, abstention),
  ).toBe(true);
  expect(await replay(job.ticket_id, { key })).toEqual(receipt);
  await expect(
    replay(job.ticket_id, { key, body: { expectedGeneration: 2 } }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await ownership().complete(old.jobId, old.attemptId, abstention)).toBe(
    false,
  );
  expect(await readTicket(job.ticket_id)).toMatchObject({
    generation: 2,
    status: 'completed',
  });
  expect(await counts()).toEqual({
    executions: 2,
    receipts: 1,
    audits: 1,
    events: 2,
  });
});
test('same keys are scoped per ticket and independently from submission keys', async () => {
  const first = await failed(),
    second = await failed(),
    key = (
      await migrator.query(
        "SELECT key FROM lab.idempotency_records WHERE ticket_id=$1 AND operation='tickets:create:v1'",
        [first.job.ticket_id],
      )
    ).rows[0].key;
  expect((await replay(first.job.ticket_id, { key })).generation).toBe(2);
  expect((await replay(second.job.ticket_id, { key })).generation).toBe(2);
  expect(await counts()).toEqual({
    executions: 4,
    receipts: 2,
    audits: 2,
    events: 4,
  });
});
test.each(['queued', 'processing', 'completed'])(
  'new replay of %s is rejected without mutations',
  async (status) => {
    let job;
    if (status === 'queued') {
      const receipt = await submitted();
      job = { ticket_id: receipt.ticketId };
    } else {
      job = await admitted();
      const c = await ownership().claim();
      if (status === 'completed')
        await ownership().complete(c.jobId, c.attemptId, abstention);
    }
    await expect(replay(job.ticket_id)).rejects.toMatchObject({
      code: 'REPLAY_CONFLICT',
    });
    expect(await counts()).toEqual({
      executions: 1,
      receipts: 0,
      audits: 0,
      events: 1,
    });
  },
);
test('wrong expected generation is a conflict without a side effect', async () => {
  const { job } = await failed();
  await expect(
    replay(job.ticket_id, { body: { expectedGeneration: 2 } }),
  ).rejects.toMatchObject({ code: 'REPLAY_CONFLICT' });
  expect((await counts()).audits).toBe(0);
});
test.each(['reader', 'requester'])(
  'a %s cannot retrieve a replay receipt or advance generation',
  async (role) => {
    const { job } = await failed(),
      key = randomUUID();
    await replay(job.ticket_id, { key });
    await migrator.query('UPDATE lab.principals SET role=$2 WHERE id=$1', [
      principal,
      role,
    ]);
    try {
      await expect(replay(job.ticket_id, { key })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    } finally {
      await migrator.query(
        "UPDATE lab.principals SET role='operator' WHERE id=$1",
        [principal],
      );
    }
    expect((await counts()).receipts).toBe(1);
  },
);
test('a disabled operator cannot retrieve an old receipt', async () => {
  const { job } = await failed(),
    key = randomUUID();
  await replay(job.ticket_id, { key });
  await migrator.query(
    'UPDATE lab.principals SET disabled_at=CURRENT_TIMESTAMP WHERE id=$1',
    [principal],
  );
  try {
    await expect(replay(job.ticket_id, { key })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  } finally {
    await migrator.query(
      'UPDATE lab.principals SET disabled_at=NULL WHERE id=$1',
      [principal],
    );
  }
});
test('foreign and missing tickets are indistinguishable for an operator', async () => {
  const { job } = await failed(),
    otherTenant = randomUUID(),
    other = randomUUID();
  await migrator.query('INSERT INTO lab.tenants(id,name) VALUES($1,$2)', [
    otherTenant,
    'Other fictional replay tenant',
  ]);
  await migrator.query(
    "INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,'operator')",
    [other, otherTenant],
  );
  for (const ticketId of [job.ticket_id, randomUUID()])
    await expect(
      replay(ticketId, { tenantId: otherTenant, principalId: other }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await counts()).audits).toBe(0);
});
test('a failure after audit insertion rolls back execution, event, receipt and generation', async () => {
  const { job } = await failed();
  const pool = {
    connect: async () => {
      const client = await apiPool.connect();
      return {
        release: (discard) => client.release(discard),
        query: async (sql, args) => {
          const result = await client.query(sql, args);
          if (sql.startsWith('INSERT INTO lab.audit_records'))
            throw new Error('private failure');
          return result;
        },
      };
    },
  };
  await expect(
    new TicketReplays(pool).replay({
      tenantId: tenant,
      principalId: principal,
      ticketId: job.ticket_id,
      requestId: randomUUID(),
      key: randomUUID(),
      body: { expectedGeneration: 1 },
    }),
  ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  expect(await counts()).toEqual({
    executions: 1,
    receipts: 0,
    audits: 0,
    events: 1,
  });
  expect((await readTicket(job.ticket_id)).generation).toBe(1);
});
test('a lost COMMIT acknowledgement is resolved by same-key retry', async () => {
  const { job } = await failed(),
    key = randomUUID();
  const pool = {
    connect: async () => {
      const client = await apiPool.connect();
      return {
        release: (discard) => client.release(discard),
        query: async (sql, args) => {
          const result = await client.query(sql, args);
          if (sql === 'COMMIT') throw new Error('private lost reply');
          return result;
        },
      };
    },
  };
  await expect(
    new TicketReplays(pool).replay({
      tenantId: tenant,
      principalId: principal,
      ticketId: job.ticket_id,
      requestId: randomUUID(),
      key,
      body: { expectedGeneration: 1 },
    }),
  ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  expect((await replay(job.ticket_id, { key })).generation).toBe(2);
  expect(await counts()).toEqual({
    executions: 2,
    receipts: 1,
    audits: 1,
    events: 2,
  });
});
test('runtime grants cannot alter replay audit history or ticket content', async () => {
  const { job } = await failed();
  await replay(job.ticket_id);
  const c = await apiPool.connect();
  try {
    await c.query('SET ROLE lab_api');
    for (const sql of [
      'UPDATE lab.audit_records SET request_id=id',
      'DELETE FROM lab.audit_records',
      "UPDATE lab.tickets SET message='changed'",
      'UPDATE lab.tickets SET created_by=id',
    ])
      await expect(c.query(sql)).rejects.toMatchObject({ code: '42501' });
  } finally {
    c.release(true);
  }
});

test('an old event after a real replay is stale and cannot schedule the new generation', async () => {
  const { job } = await failed();
  await replay(job.ticket_id);
  const old = JSON.parse(
    (
      await migrator.query(
        "SELECT payload FROM lab.outbox_events WHERE generation=1 AND type='ticket.execution.requested'",
      )
    ).rows[0].payload,
  );
  old.eventId = randomUUID();
  const {
    SchedulingAdmissions,
  } = require('../../apps/worker/dist/scheduling-admissions');
  expect(
    await new SchedulingAdmissions(workerPool).admit({
      topic: 'tickets.execution-requested.v1',
      partition: 0,
      offset: '99',
      key: Buffer.from(job.ticket_id),
      value: Buffer.from(JSON.stringify(old)),
    }),
  ).toEqual({ disposition: 'stale' });
  expect(
    (await migrator.query('SELECT count(*)::int AS n FROM lab.execution_jobs'))
      .rows[0].n,
  ).toBe(1);
  expect(await readTicket(job.ticket_id)).toMatchObject({
    generation: 2,
    status: 'queued',
  });
});
