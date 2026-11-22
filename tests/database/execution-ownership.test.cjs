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
}, 180000);
afterEach(async () => {
  await migrator.query(
    'TRUNCATE lab.execution_attempts,lab.execution_jobs,lab.consumer_inbox,lab.event_quarantine,lab.idempotency_records,lab.outbox_events,lab.ticket_executions,lab.tickets',
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
test('an admitted job is claimed with a durable attempt and processing lifecycle in one transaction', async () => {
  const job = await admitted();
  const claim = await ownership().claim();
  expect(claim).toMatchObject({
    jobId: job.id,
    ticketId: job.ticket_id,
    tenantId: tenant,
    generation: 1,
    attemptNumber: 1,
  });
  expect(
    (
      await migrator.query(
        'SELECT status,attempt_count,attempt_id FROM lab.execution_jobs',
      )
    ).rows,
  ).toEqual([
    { status: 'running', attempt_count: 1, attempt_id: claim.attemptId },
  ]);
  expect(
    (await migrator.query('SELECT status FROM lab.ticket_executions')).rows,
  ).toEqual([{ status: 'processing' }]);
  expect(
    (
      await migrator.query(
        'SELECT id,status,attempt_number FROM lab.execution_attempts',
      )
    ).rows,
  ).toEqual([{ id: claim.attemptId, status: 'running', attempt_number: 1 }]);
});

async function expire(claim) {
  await migrator.query(
    "UPDATE lab.execution_jobs SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
    [claim.jobId],
  );
}
async function eligible(id) {
  await migrator.query(
    "UPDATE lab.execution_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [id],
  );
}
async function state(id) {
  return (
    await migrator.query('SELECT * FROM lab.execution_jobs WHERE id=$1', [id])
  ).rows[0];
}
async function failures() {
  return (
    await migrator.query(
      "SELECT * FROM lab.outbox_events WHERE type='ticket.execution.failed'",
    )
  ).rows;
}
test('queued tickets cannot be claimed before consumer admission', async () => {
  await submitted();
  expect(await ownership().claim()).toBeNull();
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_attempts',
      )
    ).rows[0].n,
  ).toBe(0);
});
test('concurrent claimers assign one token and consume one attempt for a job', async () => {
  const job = await admitted();
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => ownership().claim()),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect((await state(job.id)).attempt_count).toBe(1);
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_attempts',
      )
    ).rows[0].n,
  ).toBe(1);
  expect(await ownership().claim()).toBeNull();
});
test('claim skips a locked ticket and claims another eligible job', async () => {
  const first = await admitted(),
    second = await admitted();
  await migrator.query('BEGIN');
  await migrator.query('SELECT id FROM lab.tickets WHERE id=$1 FOR UPDATE', [
    first.ticket_id,
  ]);
  try {
    expect((await ownership().claim()).jobId).toBe(second.id);
  } finally {
    await migrator.query('ROLLBACK');
  }
  expect((await state(first.id)).attempt_count).toBe(0);
  expect((await ownership().claim()).jobId).toBe(first.id);
});
test('renewal extends the live lease without a new token, attempt or budget reset', async () => {
  await admitted();
  const claim = await ownership().claim();
  await migrator.query(
    "UPDATE lab.execution_jobs SET lease_expires_at=clock_timestamp()+interval '10 seconds' WHERE id=$1",
    [claim.jobId],
  );
  expect(await ownership().renew(claim.jobId, claim.attemptId)).toBe(true);
  const remaining = (
    await migrator.query(
      'SELECT extract(epoch FROM lease_expires_at-clock_timestamp())::float AS seconds FROM lab.execution_jobs',
    )
  ).rows[0].seconds;
  expect(remaining).toBeGreaterThan(25);
  expect(remaining).toBeLessThanOrEqual(30);
  expect(await state(claim.jobId)).toMatchObject({
    attempt_id: claim.attemptId,
    attempt_count: 1,
    status: 'running',
  });
});
test('expired attempts are retained and a recovered owner receives a different token', async () => {
  await admitted();
  const first = await ownership().claim();
  await expire(first);
  const second = await ownership().claim();
  expect(second.attemptId).not.toBe(first.attemptId);
  expect(second.attemptNumber).toBe(2);
  expect(
    (
      await migrator.query(
        'SELECT status,failure_code FROM lab.execution_attempts WHERE id=$1',
        [first.attemptId],
      )
    ).rows,
  ).toEqual([{ status: 'expired', failure_code: 'LEASE_EXPIRED' }]);
  for (const operation of ['renew', 'retry', 'fail'])
    expect(await ownership()[operation](first.jobId, first.attemptId)).toBe(
      false,
    );
  expect(await state(first.jobId)).toMatchObject({
    status: 'running',
    attempt_id: second.attemptId,
    attempt_count: 2,
  });
});
test.each(['renew', 'retry', 'fail'])(
  'ownership for %s is evaluated after the row lock even when the row is unchanged through expiry',
  async (operation) => {
    await admitted();
    const claim = await ownership().claim();
    await migrator.query(
      "UPDATE lab.execution_jobs SET lease_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",
      [claim.jobId],
    );
    await migrator.query('BEGIN');
    await migrator.query('SELECT id FROM lab.tickets WHERE id=$1 FOR UPDATE', [
      claim.ticketId,
    ]);
    const pending = ownership()[operation](claim.jobId, claim.attemptId);
    const settled = Promise.allSettled([pending]);
    try {
      const deadline = performance.now() + 1500;
      let blocked = false,
        expired = false;
      while (performance.now() < deadline) {
        blocked ||=
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='execution-worker-test' AND wait_event_type='Lock'",
            )
          ).rows[0].n > 0;
        expired = (
          await migrator.query(
            'SELECT lease_expires_at<=clock_timestamp() AS expired FROM lab.execution_jobs WHERE id=$1',
            [claim.jobId],
          )
        ).rows[0].expired;
        if (blocked && expired) break;
        await delay(20);
      }
      expect(blocked).toBe(true);
      expect(expired).toBe(true);
      await migrator.query('COMMIT');
      expect(await pending).toBe(false);
      expect((await state(claim.jobId)).status).toBe('running');
      expect(await failures()).toHaveLength(0);
    } finally {
      await migrator.query('ROLLBACK');
      await settled;
    }
  },
);
test('retry retains attempt history and uses bounded database-time eligibility before the next claim', async () => {
  await admitted();
  const claim = await ownership().claim();
  expect(await ownership().retry(claim.jobId, claim.attemptId)).toBe(true);
  expect(await state(claim.jobId)).toMatchObject({
    status: 'queued',
    attempt_id: null,
    lease_expires_at: null,
    attempt_count: 1,
  });
  const check = (
    await migrator.query(
      "SELECT j.available_at>=a.finished_at AND j.available_at<=clock_timestamp()+interval '1 second' AS bounded FROM lab.execution_jobs j JOIN lab.execution_attempts a ON a.id=$1 WHERE j.id=$2",
      [claim.attemptId, claim.jobId],
    )
  ).rows[0];
  expect(check.bounded).toBe(true);
  await migrator.query(
    "UPDATE lab.execution_jobs SET available_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
    [claim.jobId],
  );
  expect(await ownership().claim()).toBeNull();
  await eligible(claim.jobId);
  expect((await ownership().claim()).attemptNumber).toBe(2);
  expect(await failures()).toHaveLength(0);
});
test('permanent failure atomically closes ownership and emits one stable sanitized notification', async () => {
  const job = await admitted(true),
    claim = await ownership().claim();
  expect(await ownership().fail(claim.jobId, claim.attemptId)).toBe(true);
  expect(await ownership().fail(claim.jobId, claim.attemptId)).toBe(false);
  expect(await ownership().claim()).toBeNull();
  expect(await state(job.id)).toMatchObject({
    status: 'failed',
    failure_code: 'EXECUTION_FAILED',
    attempt_id: null,
    lease_expires_at: null,
    attempt_count: 1,
  });
  const notifications = await failures();
  expect(notifications).toHaveLength(1);
  const body = JSON.parse(notifications[0].payload);
  const execution = (
    await migrator.query(
      'SELECT status,correlation_id,scheduling_event_id FROM lab.ticket_executions',
    )
  ).rows[0];
  expect(execution.status).toBe('failed');
  expect(body.correlationId).toBe(execution.correlation_id);
  expect(body.causationId).toBe(job.source_event_id);
  expect(body.causationId).not.toBe(execution.scheduling_event_id);
  expect(body.data).toEqual({
    failureCode: 'EXECUTION_FAILED',
    attemptCount: 1,
  });
  expect(notifications[0].payload_digest).toEqual(
    createHash('sha256').update(notifications[0].payload).digest(),
  );
  expect(notifications[0].published_at).toBeNull();
});
test.each(['crash', 'retry'])(
  'three %s attempts exhaust the stored budget without a fourth claim',
  async (mode) => {
    await admitted();
    let claim = await ownership().claim();
    for (let number = 1; number <= 3; number++) {
      expect(claim.attemptNumber).toBe(number);
      if (mode === 'crash') await expire(claim);
      else
        expect(await ownership().retry(claim.jobId, claim.attemptId)).toBe(
          true,
        );
      if (number < 3) {
        await eligible(claim.jobId);
        claim = await ownership().claim();
      }
    }
    expect(await ownership().claim()).toBeNull();
    expect(await ownership().claim()).toBeNull();
    const job = await state(claim.jobId);
    expect(job).toMatchObject({
      status: 'failed',
      attempt_count: 3,
      failure_code: 'ATTEMPTS_EXHAUSTED',
    });
    expect(
      (
        await migrator.query(
          'SELECT count(*)::int AS n FROM lab.execution_attempts',
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (await failures()).map((row) => JSON.parse(row.payload).data),
    ).toEqual([{ failureCode: 'ATTEMPTS_EXHAUSTED', attemptCount: 3 }]);
  },
);
test('failure-notification write failure rolls back the attempt, job and execution changes', async () => {
  await admitted();
  const claim = await ownership().claim();
  await migrator.query(
    "CREATE FUNCTION lab.reject_execution_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='ticket.execution.failed' THEN RAISE EXCEPTION 'fixture-private-failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_execution_failure BEFORE INSERT ON lab.outbox_events FOR EACH ROW EXECUTE FUNCTION lab.reject_execution_failure()",
  );
  try {
    await expect(
      ownership().fail(claim.jobId, claim.attemptId),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(await state(claim.jobId)).toMatchObject({
      status: 'running',
      attempt_id: claim.attemptId,
    });
    expect(
      (await migrator.query('SELECT status FROM lab.execution_attempts')).rows,
    ).toEqual([{ status: 'running' }]);
    expect(await failures()).toHaveLength(0);
  } finally {
    await migrator.query(
      'DROP TRIGGER reject_execution_failure ON lab.outbox_events; DROP FUNCTION lab.reject_execution_failure()',
    );
  }
  expect(await ownership().fail(claim.jobId, claim.attemptId)).toBe(true);
});
test('lost terminal commit acknowledgement cannot create another failure notification', async () => {
  await admitted();
  const claim = await ownership().claim();
  let lose = true;
  const proxy = {
    async connect() {
      const c = await workerPool.connect();
      return {
        async query(text, values) {
          const result = await c.query(text, values);
          if (text === 'COMMIT' && lose) {
            lose = false;
            throw new Error('fixture-private-commit');
          }
          return result;
        },
        release(discard) {
          c.release(discard);
        },
      };
    },
  };
  await expect(
    ownership(proxy).fail(claim.jobId, claim.attemptId),
  ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  const [original] = await failures();
  expect(original).toBeDefined();
  expect(await ownership().fail(claim.jobId, claim.attemptId)).toBe(false);
  expect((await failures()).map((row) => row.event_id)).toEqual([
    original.event_id,
  ]);
});
test('a lost claim acknowledgement leaves the committed lease recoverable without another immediate attempt', async () => {
  const job = await admitted();
  let lose = true;
  const proxy = {
    async connect() {
      const c = await workerPool.connect();
      return {
        async query(text, values) {
          const result = await c.query(text, values);
          if (text === 'COMMIT' && lose) {
            lose = false;
            throw new Error('fixture-private-claim');
          }
          return result;
        },
        release(discard) {
          c.release(discard);
        },
      };
    },
  };
  await expect(ownership(proxy).claim()).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
  });
  expect(await ownership().claim()).toBeNull();
  expect(await state(job.id)).toMatchObject({
    status: 'running',
    attempt_count: 1,
  });
});
test('a failed claim transaction leaves no attempt, token or processing state', async () => {
  const job = await admitted();
  await migrator.query(
    "CREATE FUNCTION lab.reject_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='processing' THEN RAISE EXCEPTION 'fixture-private-claim'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_claim BEFORE UPDATE ON lab.ticket_executions FOR EACH ROW EXECUTE FUNCTION lab.reject_claim()",
  );
  try {
    await expect(ownership().claim()).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(await state(job.id)).toMatchObject({
      status: 'queued',
      attempt_count: 0,
      attempt_id: null,
    });
    expect(
      (
        await migrator.query(
          'SELECT count(*)::int AS n FROM lab.execution_attempts',
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await migrator.query('SELECT status FROM lab.ticket_executions')).rows,
    ).toEqual([{ status: 'queued' }]);
  } finally {
    await migrator.query(
      'DROP TRIGGER reject_claim ON lab.ticket_executions; DROP FUNCTION lab.reject_claim()',
    );
  }
  expect((await ownership().claim()).attemptNumber).toBe(1);
});
test('generation changes fence an old live owner and unscheduled new executions are not claimed', async () => {
  await admitted();
  const claim = await ownership().claim();
  const next = {
    eventId: randomUUID(),
    type: 'ticket.execution.requested',
    version: 1,
    occurredAt: new Date().toISOString(),
    tenantId: tenant,
    ticketId: claim.ticketId,
    generation: 2,
    correlationId: randomUUID(),
    causationId: randomUUID(),
    data: { reason: 'replayed' },
  };
  const payload = JSON.stringify(next);
  // Trusted fixture only: a real replay API must first require a failed generation.
  await migrator.query('BEGIN');
  try {
    await migrator.query(
      "INSERT INTO lab.ticket_executions(tenant_id,ticket_id,generation,status,scheduling_reason,requested_by,correlation_id,scheduling_event_id) VALUES($1,$2,2,'queued','replayed',$3,$4,$5)",
      [tenant, claim.ticketId, principal, next.correlationId, next.eventId],
    );
    await migrator.query(
      "INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest) VALUES($1,$2,$3,2,'ticket.execution.requested',1,$4,$5)",
      [
        next.eventId,
        tenant,
        claim.ticketId,
        payload,
        createHash('sha256').update(payload).digest(),
      ],
    );
    await migrator.query(
      'UPDATE lab.tickets SET current_generation=2 WHERE id=$1',
      [claim.ticketId],
    );
    await migrator.query('COMMIT');
  } catch (error) {
    await migrator.query('ROLLBACK');
    throw error;
  }
  for (const op of ['renew', 'retry', 'fail'])
    expect(await ownership()[op](claim.jobId, claim.attemptId)).toBe(false);
  expect(await ownership().claim()).toBeNull();
  expect(await failures()).toHaveLength(0);
});
test('attempt ownership cannot point at another job and terminal outcomes cannot omit their safe code', async () => {
  await admitted();
  await admitted();
  const first = await ownership().claim(),
    second = await ownership().claim();
  const client = await workerPool.connect();
  try {
    await client.query('SET ROLE lab_worker');
    await expect(
      client.query('UPDATE lab.execution_jobs SET attempt_id=$2 WHERE id=$1', [
        first.jobId,
        second.attemptId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      client.query(
        "UPDATE lab.execution_attempts SET status='failed',finished_at=clock_timestamp(),failure_code=NULL WHERE id=$1",
        [first.attemptId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    for (const sql of [
      'SELECT message FROM lab.tickets',
      'SELECT secret_digest FROM lab.auth_credentials',
      'SELECT payload FROM lab.outbox_events',
      'UPDATE lab.execution_jobs SET max_attempts=100',
      'UPDATE lab.execution_attempts SET attempt_number=99',
    ])
      await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
  expect(await ownership().renew(first.jobId, second.attemptId)).toBe(false);
});
test('terminal notification uniqueness forbids a second logical failure identity', async () => {
  await admitted();
  const claim = await ownership().claim();
  await ownership().fail(claim.jobId, claim.attemptId);
  const [notification] = await failures();
  const body = { ...JSON.parse(notification.payload), eventId: randomUUID() },
    payload = JSON.stringify(body);
  await expect(
    migrator.query(
      "INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest) VALUES($1,$2,$3,1,'ticket.execution.failed',1,$4,$5)",
      [
        body.eventId,
        tenant,
        claim.ticketId,
        payload,
        createHash('sha256').update(payload).digest(),
      ],
    ),
  ).rejects.toMatchObject({ code: '23505' });
  expect(await failures()).toHaveLength(1);
});
