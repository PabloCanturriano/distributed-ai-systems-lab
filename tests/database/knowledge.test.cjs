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
let container, admin, migrator, apiPool, workerPool, operationsPool, seedPool;
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
  seedPool = await login('seed');
}, 180000);
afterEach(async () => {
  await migrator.query(
    'TRUNCATE lab.result_citations,lab.execution_evidence,lab.execution_configurations,lab.tenant_corpus_profiles,lab.corpus_snapshot_documents,lab.chunk_embeddings,lab.document_chunks,lab.document_versions,lab.documents,lab.corpus_snapshots,lab.delivery_repairs,lab.audit_records,lab.execution_results,lab.execution_attempts,lab.execution_jobs,lab.consumer_inbox,lab.event_quarantine,lab.idempotency_records,lab.outbox_events,lab.ticket_executions,lab.tickets',
  );
});
afterAll(async () => {
  await seedPool?.end();
  await operationsPool?.end();
  await workerPool?.end();
  await apiPool?.end();
  await migrator?.end();
  await admin?.end();
  await container?.stop();
});

const otherTenant = randomUUID(),
  snapshot = randomUUID(),
  otherSnapshot = randomUUID(),
  document = randomUUID(),
  foreignDoc = randomUUID();
let seedKnowledge;
beforeAll(async () => {
  ({ seedKnowledge } = await import('../../database/dist/index.js'));
  await migrator.query('INSERT INTO lab.tenants(id,name) VALUES($1,$2)', [
    otherTenant,
    'Other fictional knowledge tenant',
  ]);
});
const manifest = () => ({
  version: 'corpus-test-v1',
  tenants: [
    {
      tenantId: tenant,
      snapshotId: snapshot,
      documents: [
        {
          id: document,
          version: 'v1',
          title: 'Retry policy',
          content:
            'Harbor retry policy uses exponential jitter and three attempts. HARBOR_ONLY_SENTINEL',
        },
      ],
    },
    {
      tenantId: otherTenant,
      snapshotId: otherSnapshot,
      documents: [
        {
          id: foreignDoc,
          version: 'v1',
          title: 'Retry policy',
          content:
            'Summit retry policy uses manual escalation and two reviews. SUMMIT_ONLY_SENTINEL',
        },
      ],
    },
  ],
});
async function seed(input = manifest()) {
  const c = await seedPool.connect();
  try {
    await c.query('SET ROLE lab_seed');
    return await seedKnowledge(c, input);
  } finally {
    c.release();
  }
}
test('corpus seed is repeatable and immutable versions cannot be overwritten', async () => {
  expect((await seed()).status).toBe('created');
  expect((await seed()).status).toBe('unchanged');
  const changed = manifest();
  changed.tenants[0].snapshotId = randomUUID();
  changed.tenants[0].documents[0].content = 'Changed immutable source';
  await expect(seed(changed)).rejects.toThrow('Knowledge provisioning failed');
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.corpus_snapshots',
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (
      await migrator.query(
        'SELECT source_text FROM lab.document_versions WHERE tenant_id=$1',
        [tenant],
      )
    ).rows[0].source_text,
  ).toContain('HARBOR_ONLY_SENTINEL');
});
test('exact pgvector retrieval filters the authorized tenant and pinned snapshot before returning context', async () => {
  await seed();
  const {
    KnowledgeRetrieval,
  } = require('../../apps/worker/dist/knowledge-retrieval');
  const store = new KnowledgeRetrieval(workerPool);
  const result = await store.search({
    tenantId: tenant,
    snapshotId: snapshot,
    profile: 'lexical-hash-v1',
    query: 'retry policy exponential jitter',
  });
  expect(result).toHaveLength(1);
  expect(result[0].documentId).toBe(document);
  expect(JSON.stringify(result)).not.toContain('SUMMIT_ONLY_SENTINEL');
  await expect(
    store.search({
      tenantId: tenant,
      snapshotId: otherSnapshot,
      profile: 'lexical-hash-v1',
      query: 'retry policy',
    }),
  ).rejects.toThrow();
  expect(
    await store.search({
      tenantId: tenant,
      snapshotId: snapshot,
      profile: 'lexical-hash-v1',
      query: '🌊',
    }),
  ).toEqual([]);
});
test('runtime roles cannot change immutable corpus rows or active pointers', async () => {
  await seed();
  for (const pool of [apiPool, workerPool, operationsPool]) {
    const c = await pool.connect();
    try {
      await c.query(
        'SET ROLE ' +
          (pool === apiPool
            ? 'lab_api'
            : pool === workerPool
              ? 'lab_worker'
              : 'lab_operations'),
      );
      for (const sql of [
        "UPDATE lab.document_versions SET source_text='changed'",
        'DELETE FROM lab.document_chunks',
        'UPDATE lab.tenant_corpus_profiles SET snapshot_id=gen_random_uuid()',
      ])
        await expect(c.query(sql)).rejects.toMatchObject({ code: '42501' });
    } finally {
      c.release(true);
    }
  }
});
test('new snapshots preserve old version membership and ordered exact scores', async () => {
  await seed();
  const next = manifest();
  next.tenants = next.tenants.slice(0, 1);
  next.tenants[0].snapshotId = randomUUID();
  next.tenants[0].documents[0].version = 'v2';
  next.tenants[0].documents[0].content =
    'Updated retry policy keeps a recovery journal.';
  await seed(next);
  const {
    KnowledgeRetrieval,
  } = require('../../apps/worker/dist/knowledge-retrieval');
  const store = new KnowledgeRetrieval(workerPool);
  expect(
    (
      await store.search({
        tenantId: tenant,
        snapshotId: snapshot,
        profile: 'lexical-hash-v1',
        query: 'exponential jitter',
      })
    )[0].documentVersion,
  ).toBe('v1');
  expect(
    (
      await store.search({
        tenantId: tenant,
        snapshotId: next.tenants[0].snapshotId,
        profile: 'lexical-hash-v1',
        query: 'recovery journal',
      })
    )[0].documentVersion,
  ).toBe('v2');
  await expect(seed()).rejects.toThrow('Knowledge provisioning failed');
});
test('cached identical queries remain scoped and callers cannot poison cached evidence', async () => {
  await seed();
  const {
    KnowledgeRetrieval,
  } = require('../../apps/worker/dist/knowledge-retrieval');
  const store = new KnowledgeRetrieval(workerPool);
  const request = {
    tenantId: tenant,
    snapshotId: snapshot,
    profile: 'lexical-hash-v1',
    query: 'retry policy',
  };
  const a = await store.search(request);
  a[0].content = 'tampered caller response';
  expect((await store.search(request))[0].content).toContain(
    'HARBOR_ONLY_SENTINEL',
  );
  const b = await store.search({
    ...request,
    tenantId: otherTenant,
    snapshotId: otherSnapshot,
  });
  expect(JSON.stringify(b)).toContain('SUMMIT_ONLY_SENTINEL');
  expect(JSON.stringify(b)).not.toContain('HARBOR_ONLY_SENTINEL');
  await expect(
    store.search({ ...request, profile: 'other-profile' }),
  ).rejects.toThrow('Invalid retrieval request');
});
test('corpus provisioning rolls back every new version and pointer on a later write failure', async () => {
  const c = await seedPool.connect();
  try {
    await c.query('SET ROLE lab_seed');
    const wrapped = {
      query: async (...args) => {
        const r = await c.query(...args);
        if (args[0].startsWith('INSERT INTO lab.corpus_snapshot_documents'))
          throw Error('fixture-write-failure');
        return r;
      },
    };
    await expect(seedKnowledge(wrapped, manifest())).rejects.toThrow(
      'Knowledge provisioning failed',
    );
    expect(
      (await migrator.query('SELECT count(*)::int AS n FROM lab.documents'))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await migrator.query(
          'SELECT count(*)::int AS n FROM lab.tenant_corpus_profiles',
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    c.release();
  }
});
test('changed snapshot bytes or missing stored chunks fail closed on reseed', async () => {
  await seed();
  const changed = manifest();
  changed.tenants[0].documents[0].content += ' changed';
  await expect(seed(changed)).rejects.toThrow('Knowledge provisioning failed');
  await migrator.query('DELETE FROM lab.chunk_embeddings WHERE tenant_id=$1', [
    tenant,
  ]);
  await expect(seed()).rejects.toThrow('Knowledge provisioning failed');
});
async function accepted(message = 'retry exponential jitter') {
  const {
    TicketSubmissions,
  } = require('../../apps/api/dist/ticket-submission');
  return new TicketSubmissions(apiPool).submit({
    tenantId: tenant,
    principalId: principal,
    requestId: randomUUID(),
    key: randomUUID(),
    body: { message },
  });
}
async function claimed(ticketId) {
  const row = (
    await migrator.query(
      'SELECT payload FROM lab.outbox_events WHERE ticket_id=$1',
      [ticketId],
    )
  ).rows[0];
  const {
    SchedulingAdmissions,
  } = require('../../apps/worker/dist/scheduling-admissions');
  await new SchedulingAdmissions(workerPool).admit({
    topic: 'tickets.execution-requested.v1',
    partition: 0,
    offset: '0',
    key: Buffer.from(ticketId),
    value: Buffer.from(row.payload),
  });
  const {
    ExecutionOwnership,
  } = require('../../apps/worker/dist/execution-ownership');
  return new ExecutionOwnership(workerPool).claim();
}
test('a new execution pins its corpus and only actually delivered citations may complete', async () => {
  await seed();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId);
  const {
      EvidenceProvider,
    } = require('../../apps/worker/dist/evidence-provider'),
    {
      ExecutionEvidence,
    } = require('../../apps/worker/dist/execution-evidence'),
    {
      KnowledgeRetrieval,
    } = require('../../apps/worker/dist/knowledge-retrieval'),
    {
      ExecutionOwnership,
    } = require('../../apps/worker/dist/execution-ownership');
  const cfg = (
    await migrator.query(
      'SELECT snapshot_id FROM lab.execution_configurations WHERE ticket_id=$1',
      [receipt.ticketId],
    )
  ).rows[0];
  expect(cfg.snapshot_id).toBe(snapshot);
  const response = await new EvidenceProvider(
    new ExecutionEvidence(workerPool),
    new KnowledgeRetrieval(workerPool),
  ).execute(claim, new AbortController().signal);
  expect(response.outcome).toBe('answered');
  expect(response.citations).toHaveLength(1);
  expect(
    await new ExecutionOwnership(workerPool).complete(
      claim.jobId,
      claim.attemptId,
      response,
    ),
  ).toBe(true);
  const { TicketReads } = require('../../apps/api/dist/ticket-read');
  const status = await new TicketReads(apiPool).get({
    tenantId: tenant,
    principalId: principal,
    ticketId: receipt.ticketId,
  });
  expect(status.result.citations).toEqual(response.citations);
  expect(status.result.answer).toContain('HARBOR_ONLY_SENTINEL');
  expect(JSON.stringify(status)).not.toContain('SUMMIT_ONLY_SENTINEL');
  await expect(
    migrator.query(
      'DELETE FROM lab.document_versions WHERE tenant_id=$1 AND document_id=$2',
      [tenant, document],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    migrator.query('DELETE FROM lab.result_citations WHERE tenant_id=$1', [
      tenant,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
});
test('fabricated or other-attempt citations leave no partial result or lifecycle change', async () => {
  await seed();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId);
  const {
    ExecutionOwnership,
  } = require('../../apps/worker/dist/execution-ownership');
  const chunk = (
    await migrator.query(
      'SELECT id FROM lab.document_chunks WHERE tenant_id=$1',
      [tenant],
    )
  ).rows[0].id;
  await expect(
    new ExecutionOwnership(workerPool).complete(claim.jobId, claim.attemptId, {
      outcome: 'answered',
      answer: 'Fabricated support',
      citations: [
        { documentId: document, documentVersion: 'v1', chunkId: chunk },
      ],
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_results',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await migrator.query('SELECT status FROM lab.execution_jobs')).rows[0]
      .status,
  ).toBe('running');
});
test('new acceptance without an active corpus rolls back but historical retries retain their receipt', async () => {
  await expect(accepted()).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
  });
  expect(
    (await migrator.query('SELECT count(*)::int AS n FROM lab.tickets')).rows[0]
      .n,
  ).toBe(0);
  await seed();
  const key = randomUUID(),
    input = {
      tenantId: tenant,
      principalId: principal,
      requestId: randomUUID(),
      key,
      body: { message: 'retry policy' },
    };
  const {
    TicketSubmissions,
  } = require('../../apps/api/dist/ticket-submission');
  const submissions = new TicketSubmissions(apiPool),
    receipt = await submissions.submit(input);
  await migrator.query(
    'DELETE FROM lab.tenant_corpus_profiles WHERE tenant_id=$1',
    [tenant],
  );
  expect(
    await submissions.submit({ ...input, requestId: randomUUID() }),
  ).toEqual(receipt);
});
test('retries retain pinned context while operator replay records the new active snapshot', async () => {
  await seed();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId);
  const {
      ExecutionOwnership,
    } = require('../../apps/worker/dist/execution-ownership'),
    {
      ExecutionEvidence,
    } = require('../../apps/worker/dist/execution-evidence');
  const owner = new ExecutionOwnership(workerPool),
    contexts = new ExecutionEvidence(workerPool);
  await owner.retry(claim.jobId, claim.attemptId);
  await migrator.query(
    "UPDATE lab.execution_jobs SET available_at=clock_timestamp()-interval '1 second'",
  );
  const next = manifest();
  next.tenants = next.tenants.slice(0, 1);
  next.tenants[0].snapshotId = randomUUID();
  next.tenants[0].documents[0].version = 'v2';
  next.tenants[0].documents[0].content = 'New recovery journal policy.';
  await seed(next);
  const recovered = await owner.claim();
  expect((await contexts.load(recovered)).snapshotId).toBe(snapshot);
  const {
      EvidenceProvider,
    } = require('../../apps/worker/dist/evidence-provider'),
    {
      KnowledgeRetrieval,
    } = require('../../apps/worker/dist/knowledge-retrieval');
  const oldAnswer = await new EvidenceProvider(
    contexts,
    new KnowledgeRetrieval(workerPool),
  ).execute(recovered, new AbortController().signal);
  expect(oldAnswer.answer).toContain('HARBOR_ONLY_SENTINEL');
  await owner.fail(recovered.jobId, recovered.attemptId);
  const operator = randomUUID();
  await migrator.query(
    "INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,'operator')",
    [operator, tenant],
  );
  const { TicketReplays } = require('../../apps/api/dist/ticket-replay');
  const replay = await new TicketReplays(apiPool).replay({
    tenantId: tenant,
    principalId: operator,
    ticketId: receipt.ticketId,
    requestId: randomUUID(),
    key: randomUUID(),
    body: { expectedGeneration: 1 },
  });
  expect(replay.generation).toBe(2);
  const configs = (
    await migrator.query(
      'SELECT generation,snapshot_id FROM lab.execution_configurations WHERE ticket_id=$1 ORDER BY generation',
      [receipt.ticketId],
    )
  ).rows;
  expect(configs).toEqual([
    { generation: 1, snapshot_id: snapshot },
    { generation: 2, snapshot_id: next.tenants[0].snapshotId },
  ]);
});
test('execution context cannot be loaded through another tenant or attempt token', async () => {
  await seed();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId),
    {
      ExecutionEvidence,
    } = require('../../apps/worker/dist/execution-evidence');
  const store = new ExecutionEvidence(workerPool);
  await expect(store.load({ ...claim, tenantId: otherTenant })).rejects.toThrow(
    'Execution evidence unavailable',
  );
  await expect(
    store.load({ ...claim, attemptId: randomUUID() }),
  ).rejects.toThrow('Execution evidence unavailable');
  expect((await store.load(claim)).tenantId).toBe(tenant);
});
test('a citation write failure rolls back the answer and leaves the live attempt recoverable', async () => {
  await seed();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId);
  const {
      EvidenceProvider,
    } = require('../../apps/worker/dist/evidence-provider'),
    {
      ExecutionEvidence,
    } = require('../../apps/worker/dist/execution-evidence'),
    {
      KnowledgeRetrieval,
    } = require('../../apps/worker/dist/knowledge-retrieval'),
    {
      ExecutionOwnership,
    } = require('../../apps/worker/dist/execution-ownership');
  const result = await new EvidenceProvider(
    new ExecutionEvidence(workerPool),
    new KnowledgeRetrieval(workerPool),
  ).execute(claim, new AbortController().signal);
  const wrapped = {
    connect: async () => {
      const c = await workerPool.connect();
      return {
        release: (flag) => c.release(flag),
        query: async (...args) => {
          const value = await c.query(...args);
          if (args[0].startsWith('INSERT INTO lab.result_citations'))
            throw Error('fictional lost citation write');
          return value;
        },
      };
    },
  };
  await expect(
    new ExecutionOwnership(wrapped).complete(
      claim.jobId,
      claim.attemptId,
      result,
    ),
  ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_results',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.result_citations',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    await new ExecutionOwnership(workerPool).complete(
      claim.jobId,
      claim.attemptId,
      result,
    ),
  ).toBe(true);
});
test('a legacy execution without pinned configuration keeps its original abstention mode', async () => {
  await seed();
  const receipt = await accepted();
  await migrator.query(
    'DELETE FROM lab.execution_configurations WHERE ticket_id=$1',
    [receipt.ticketId],
  );
  const claim = await claimed(receipt.ticketId),
    { EvidenceProvider } = require('../../apps/worker/dist/evidence-provider'),
    {
      ExecutionEvidence,
    } = require('../../apps/worker/dist/execution-evidence'),
    {
      KnowledgeRetrieval,
    } = require('../../apps/worker/dist/knowledge-retrieval');
  const response = await new EvidenceProvider(
    new ExecutionEvidence(workerPool),
    new KnowledgeRetrieval(workerPool),
  ).execute(claim, new AbortController().signal);
  expect(response.outcome).toBe('insufficient_evidence');
  expect(response.answer).toBe(
    'The simulated local provider has no indexed documentation available for this ticket.',
  );
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_evidence',
      )
    ).rows[0].n,
  ).toBe(0);
});

test('agent ticket tool reads only own-tenant lifecycle fields with the real worker role', async () => {
  await seed();
  const receipt = await accepted('PRIVATE_TOOL_MESSAGE_MUST_NOT_LEAVE');
  const { ReadOnlyAgentTools } = require('../../apps/worker/dist/agent-tools');
  const {
    KnowledgeRetrieval,
  } = require('../../apps/worker/dist/knowledge-retrieval');
  const scope = { tenantId: tenant, snapshotId: snapshot },
    signal = new AbortController().signal;
  const catalogue = { version: 'services-v1', services: [] };
  const tools = new ReadOnlyAgentTools(
    scope,
    workerPool,
    new KnowledgeRetrieval(workerPool),
    catalogue,
  );
  const result = await tools.ticket(scope, receipt.ticketId, signal);
  expect(Object.keys(result).sort()).toEqual([
    'createdAt',
    'generation',
    'status',
    'ticketId',
    'updatedAt',
  ]);
  expect(result).toMatchObject({
    ticketId: receipt.ticketId,
    generation: 1,
    status: 'queued',
  });
  expect(JSON.stringify(result)).not.toContain(
    'PRIVATE_TOOL_MESSAGE_MUST_NOT_LEAVE',
  );
  const foreignScope = { tenantId: otherTenant, snapshotId: otherSnapshot };
  const foreignTools = new ReadOnlyAgentTools(
    foreignScope,
    workerPool,
    new KnowledgeRetrieval(workerPool),
    catalogue,
  );
  const foreign = await foreignTools.ticket(
    foreignScope,
    receipt.ticketId,
    signal,
  );
  expect(foreign).toEqual({ code: 'NOT_FOUND' });
  expect(foreign).toEqual(await tools.ticket(scope, randomUUID(), signal));
});
test('the bounded offline agent uses real scoped retrieval and lifecycle tools after credential revocation', async () => {
  await seed();
  const receipt = await accepted();
  const { ReadOnlyAgentTools } = require('../../apps/worker/dist/agent-tools');
  const {
    KnowledgeRetrieval,
  } = require('../../apps/worker/dist/knowledge-retrieval');
  const { runBoundedAgent } = require('../../apps/worker/dist/bounded-agent');
  const {
    scriptedAnswer,
  } = require('../../apps/worker/dist/evidence-provider');
  const scope = { tenantId: tenant, snapshotId: snapshot },
    signal = new AbortController().signal;
  const tools = new ReadOnlyAgentTools(
    scope,
    workerPool,
    new KnowledgeRetrieval(workerPool),
    { version: 'services-v1', services: [] },
  );
  await migrator.query(
    'UPDATE lab.principals SET disabled_at=clock_timestamp() WHERE id=$1',
    [principal],
  );
  try {
    let turn = 0;
    const model = {
      mode: 'simulated',
      decide: async (input) => {
        expect(JSON.stringify(input)).not.toContain('SUMMIT_ONLY_SENTINEL');
        if (++turn === 1)
          return {
            kind: 'tool',
            name: 'get_ticket',
            arguments: { ticketId: receipt.ticketId },
          };
        expect(input.history[0].result).toMatchObject({
          ticketId: receipt.ticketId,
          status: 'queued',
        });
        return {
          kind: 'final',
          result: scriptedAnswer(input.question, input.evidence),
        };
      },
    };
    const result = await runBoundedAgent({
      context: scope,
      question: 'retry policy exponential jitter',
      signal,
      model,
      tools,
    });
    expect(result.result.outcome).toBe('answered');
    expect(result.result.citations[0].documentId).toBe(document);
    expect(result.summary.toolCalls).toEqual([
      { name: 'get_ticket', outcome: 'observed' },
    ]);
    expect(
      (
        await migrator.query(
          'SELECT count(*)::int AS n FROM lab.execution_results',
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await migrator.query(
      'UPDATE lab.principals SET disabled_at=NULL WHERE id=$1',
      [principal],
    );
  }
});

test('phase five activation upgrades only new acceptance while old receipts keep the extractive policy', async () => {
  await seed();
  const old = await accepted();
  const c = await seedPool.connect();
  try {
    await c.query('SET ROLE lab_seed');
    await seedKnowledge(c, manifest(), 'bounded-agent-v1');
  } finally {
    c.release();
  }
  const fresh = await accepted();
  const rows = (
    await migrator.query(
      'SELECT ticket_id,policy_version FROM lab.execution_configurations ORDER BY ticket_id',
    )
  ).rows;
  expect(rows.find((r) => r.ticket_id === old.ticketId).policy_version).toBe(
    'extractive-simulated-v1',
  );
  expect(rows.find((r) => r.ticket_id === fresh.ticketId).policy_version).toBe(
    'bounded-agent-v1',
  );
});
async function activateAgent() {
  const c = await seedPool.connect();
  try {
    await c.query('SET ROLE lab_seed');
    await seedKnowledge(c, manifest(), 'bounded-agent-v1');
  } finally {
    c.release();
  }
}
function agentProvider() {
  const { AgentProvider } = require('../../apps/worker/dist/agent-provider');
  return new AgentProvider(workerPool, {
    version: 'services-v1',
    services: [
      {
        tenantId: tenant,
        serviceId: 'support-api',
        status: 'operational',
        observedAt: '2026-11-25T00:00:00.000Z',
      },
    ],
  });
}
test('agent completion atomically persists delivered evidence, citations, bounded summary and lifecycle', async () => {
  await seed();
  await activateAgent();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId);
  const result = await agentProvider().execute(
    claim,
    new AbortController().signal,
  );
  expect(result.agent.summary).toEqual({
    policy: 'bounded-agent-v1',
    providerMode: 'simulated',
    modelTurns: 4,
    toolCalls: [
      { name: 'search_documentation', outcome: 'observed' },
      { name: 'get_ticket', outcome: 'observed' },
      { name: 'get_service_status', outcome: 'observed' },
    ],
  });
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_evidence',
      )
    ).rows[0].n,
  ).toBe(0);
  const {
    ExecutionOwnership,
  } = require('../../apps/worker/dist/execution-ownership');
  expect(
    await new ExecutionOwnership(workerPool).complete(
      claim.jobId,
      claim.attemptId,
      result,
    ),
  ).toBe(true);
  const saved = (
    await migrator.query('SELECT agent_summary FROM lab.execution_results')
  ).rows[0];
  expect(saved.agent_summary).toEqual(result.agent.summary);
  expect(JSON.stringify(saved)).not.toMatch(
    /SENTINEL|retry policy|arguments|content/,
  );
  const { TicketReads } = require('../../apps/api/dist/ticket-read');
  const read = await new TicketReads(apiPool).get({
    tenantId: tenant,
    principalId: principal,
    ticketId: receipt.ticketId,
  });
  expect(read.result.execution).toMatchObject({
    policy: 'bounded-agent-v1',
    modelTurns: 4,
    toolCalls: result.agent.summary.toolCalls,
  });
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.result_citations',
      )
    ).rows[0].n,
  ).toBe(1);
});
test('invalid agent references roll back evidence and metadata before a valid completion can retry', async () => {
  await seed();
  await activateAgent();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId);
  const result = await agentProvider().execute(
      claim,
      new AbortController().signal,
    ),
    forged = structuredClone(result);
  forged.citations[0].chunkId = randomUUID();
  const {
    ExecutionOwnership,
  } = require('../../apps/worker/dist/execution-ownership');
  const owner = new ExecutionOwnership(workerPool);
  await expect(
    owner.complete(claim.jobId, claim.attemptId, forged),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_evidence',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_results',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(await owner.complete(claim.jobId, claim.attemptId, result)).toBe(true);
});
test('an agent response after lease loss cannot persist and recovery repeats read-only work under a new attempt', async () => {
  await seed();
  await activateAgent();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId);
  const result = await agentProvider().execute(
    claim,
    new AbortController().signal,
  );
  await migrator.query(
    "UPDATE lab.execution_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [claim.jobId],
  );
  const {
    ExecutionOwnership,
  } = require('../../apps/worker/dist/execution-ownership');
  const owner = new ExecutionOwnership(workerPool);
  expect(await owner.complete(claim.jobId, claim.attemptId, result)).toBe(
    false,
  );
  expect(
    (
      await migrator.query(
        'SELECT count(*)::int AS n FROM lab.execution_evidence',
      )
    ).rows[0].n,
  ).toBe(0);
  const next = await owner.claim();
  expect(next.attemptNumber).toBe(2);
  const retried = await agentProvider().execute(
    next,
    new AbortController().signal,
  );
  expect(await owner.complete(next.jobId, next.attemptId, retried)).toBe(true);
  expect(await owner.complete(claim.jobId, claim.attemptId, result)).toBe(
    false,
  );
});
test('agent activation preserves the old provider and refuses incomplete or leaked summaries', async () => {
  await seed();
  const old = await accepted(),
    claim = await claimed(old.ticketId);
  await activateAgent();
  const legacy = await agentProvider().execute(
    claim,
    new AbortController().signal,
  );
  expect(legacy.agent).toBeUndefined();
  const {
    ExecutionOwnership,
  } = require('../../apps/worker/dist/execution-ownership');
  const owner = new ExecutionOwnership(workerPool);
  expect(await owner.complete(claim.jobId, claim.attemptId, legacy)).toBe(true);
  const receipt = await accepted(),
    next = await claimed(receipt.ticketId),
    result = await agentProvider().execute(next, new AbortController().signal);
  const { agent, ...missing } = result;
  await expect(
    owner.complete(next.jobId, next.attemptId, missing),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(() =>
    owner.complete(next.jobId, next.attemptId, {
      ...result,
      agent: {
        ...agent,
        summary: { ...agent.summary, question: 'FAKE_PRIVATE_SECRET' },
      },
    }),
  ).toThrow('INVALID_REQUEST');
  expect(await owner.complete(next.jobId, next.attemptId, result)).toBe(true);
  const c = await seedPool.connect();
  try {
    await c.query('SET ROLE lab_seed');
    await expect(seedKnowledge(c, manifest())).rejects.toThrow(
      'Knowledge provisioning failed',
    );
  } finally {
    c.release();
  }
});
test('database summary constraints reject forged names, excess keys and JSON null authority', async () => {
  const base = {
    policy: 'bounded-agent-v1',
    providerMode: 'simulated',
    modelTurns: 2,
    toolCalls: [{ name: 'get_ticket', outcome: 'observed' }],
  };
  for (const bad of [
    { ...base, policy: null },
    { ...base, modelTurns: null },
    { ...base, toolCalls: null },
    { ...base, secret: 'FAKE_SECRET' },
    { ...base, toolCalls: [{ name: null, outcome: 'observed' }] },
    { ...base, toolCalls: [{ name: 'fetch_url', outcome: 'observed' }] },
    { ...base, toolCalls: [{ name: 'get_ticket', outcome: null }] },
    { ...base, modelTurns: 1 },
  ]) {
    expect(
      (
        await migrator.query(
          'SELECT lab.valid_agent_summary($1::jsonb) AS valid',
          [JSON.stringify(bad)],
        )
      ).rows[0].valid,
    ).toBe(false);
  }
});
test('policy replay binds the activated agent without reinterpreting a retried extractive generation', async () => {
  await seed();
  const receipt = await accepted(),
    claim = await claimed(receipt.ticketId);
  const {
    ExecutionOwnership,
  } = require('../../apps/worker/dist/execution-ownership');
  const owner = new ExecutionOwnership(workerPool);
  await owner.retry(claim.jobId, claim.attemptId);
  await activateAgent();
  await migrator.query(
    "UPDATE lab.execution_jobs SET available_at=clock_timestamp()-interval '1 second'",
  );
  const retried = await owner.claim(),
    old = await agentProvider().execute(retried, new AbortController().signal);
  expect(old.agent).toBeUndefined();
  await owner.fail(retried.jobId, retried.attemptId);
  const operator = randomUUID();
  await migrator.query(
    "INSERT INTO lab.principals(id,tenant_id,role) VALUES($1,$2,'operator')",
    [operator, tenant],
  );
  const { TicketReplays } = require('../../apps/api/dist/ticket-replay');
  const replay = await new TicketReplays(apiPool).replay({
    tenantId: tenant,
    principalId: operator,
    ticketId: receipt.ticketId,
    requestId: randomUUID(),
    key: randomUUID(),
    body: { expectedGeneration: 1 },
  });
  expect(replay.generation).toBe(2);
  expect(
    (
      await migrator.query(
        'SELECT generation,policy_version FROM lab.execution_configurations WHERE ticket_id=$1 ORDER BY generation',
        [receipt.ticketId],
      )
    ).rows,
  ).toEqual([
    { generation: 1, policy_version: 'extractive-simulated-v1' },
    { generation: 2, policy_version: 'bounded-agent-v1' },
  ]);
});
