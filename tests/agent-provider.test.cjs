const {
  AgentProvider,
  OfflineTicketModel,
} = require('../apps/worker/dist/agent-provider');
const { ExecutionEvidence } = require('../apps/worker/dist/execution-evidence');
const {
  KnowledgeRetrieval,
} = require('../apps/worker/dist/knowledge-retrieval');
const { createTelemetry } = require('../packages/telemetry/dist');
const tenantId = 'a1000000-0000-4000-8000-000000000001',
  snapshotId = 'c1000000-0000-4000-8000-000000000001';
const claim = {
  tenantId,
  ticketId: tenantId,
  attemptId: snapshotId,
  generation: 1,
};
afterEach(() => jest.restoreAllMocks());
test('provider exceptions and fake secrets never enter safe errors or model/tool telemetry', async () => {
  const spans = [];
  const telemetry = createTelemetry('lab-worker', 'executor', (row) => {
    spans.push(row);
    return true;
  });
  jest.spyOn(ExecutionEvidence.prototype, 'load').mockResolvedValue({
    tenantId,
    snapshotId,
    profile: 'lexical-hash-v1',
    policy: 'bounded-agent-v1',
    message: 'FAKE_PRIVATE_REQUEST',
  });
  jest
    .spyOn(KnowledgeRetrieval.prototype, 'search')
    .mockRejectedValue(Error('FAKE_PROVIDER_SECRET'));
  const provider = new AgentProvider(
    { connect: jest.fn() },
    { version: 'services-v1', services: [] },
    telemetry,
  );
  await expect(
    provider.execute(claim, new AbortController().signal),
  ).rejects.toMatchObject({
    message: 'Execution provider failed',
    classification: 'retryable',
  });
  expect(JSON.stringify(spans)).not.toMatch(
    /FAKE_PROVIDER_SECRET|FAKE_PRIVATE_REQUEST/,
  );
  expect(spans).toEqual([
    expect.objectContaining({ stage: 'retrieval.search', outcome: 'failed' }),
  ]);
});
test('incompatible decisions are terminal and cannot start a model-selected tool', async () => {
  jest.spyOn(ExecutionEvidence.prototype, 'load').mockResolvedValue({
    tenantId,
    snapshotId,
    profile: 'lexical-hash-v1',
    policy: 'bounded-agent-v1',
    message: 'retry policy',
  });
  jest.spyOn(KnowledgeRetrieval.prototype, 'search').mockResolvedValue([]);
  jest.spyOn(OfflineTicketModel.prototype, 'decide').mockResolvedValue({
    kind: 'tool',
    name: 'fetch_url',
    arguments: { url: 'https://untrusted.invalid' },
  });
  const pool = { connect: jest.fn() };
  const provider = new AgentProvider(pool, {
    version: 'services-v1',
    services: [],
  });
  await expect(
    provider.execute(claim, new AbortController().signal),
  ).rejects.toMatchObject({ classification: 'permanent' });
  expect(pool.connect).not.toHaveBeenCalled();
});
test('the fixed offline model does not truncate oversized search arguments or interpret document instructions', async () => {
  const model = new OfflineTicketModel(tenantId);
  expect(
    await model.decide(
      { question: 'x'.repeat(501), evidence: [], history: [] },
      new AbortController().signal,
    ),
  ).toEqual({
    kind: 'tool',
    name: 'get_ticket',
    arguments: { ticketId: tenantId },
  });
  const final = await model.decide(
    {
      question: 'retry policy',
      evidence: [],
      history: [
        { name: 'search_documentation', result: [] },
        { name: 'get_ticket', result: { code: 'NOT_FOUND' } },
        { name: 'get_service_status', result: { code: 'NOT_FOUND' } },
      ],
    },
    new AbortController().signal,
  );
  expect(final).toMatchObject({
    kind: 'final',
    result: { outcome: 'insufficient_evidence', citations: [] },
  });
});
