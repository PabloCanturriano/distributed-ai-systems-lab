const { ReadOnlyAgentTools } = require('../apps/worker/dist/agent-tools');
const scope = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  snapshotId: 'c1000000-0000-4000-8000-000000000001',
};
const otherTenant = 'a1000000-0000-4000-8000-000000000002';
const catalogue = {
  version: 'services-v1',
  services: [
    {
      tenantId: scope.tenantId,
      serviceId: 'harbor-api',
      status: 'operational',
      observedAt: '2026-11-24T00:00:00.000Z',
    },
    {
      tenantId: otherTenant,
      serviceId: 'summit-api',
      status: 'degraded',
      observedAt: '2026-11-24T00:00:00.000Z',
    },
  ],
};
const signal = new AbortController().signal;
test('the fictional service catalogue returns only the accepted tenant and does not disclose foreign IDs', async () => {
  const tools = new ReadOnlyAgentTools(
    scope,
    { connect: jest.fn() },
    { search: jest.fn() },
    catalogue,
  );
  expect(await tools.serviceStatus(scope, 'harbor-api', signal)).toEqual({
    serviceId: 'harbor-api',
    status: 'operational',
    observedAt: '2026-11-24T00:00:00.000Z',
  });
  expect(await tools.serviceStatus(scope, 'summit-api', signal)).toEqual(
    await tools.serviceStatus(scope, 'missing-api', signal),
  );
});
test('a bound tool set cannot be reused under another tenant or snapshot', async () => {
  const retrieval = { search: jest.fn() };
  const pool = { connect: jest.fn() };
  const tools = new ReadOnlyAgentTools(scope, pool, retrieval, catalogue);
  for (const changed of [
    { ...scope, tenantId: otherTenant },
    { ...scope, snapshotId: otherTenant },
  ]) {
    await expect(
      tools.serviceStatus(changed, 'harbor-api', signal),
    ).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
    await expect(tools.search(changed, 'retry', signal)).rejects.toMatchObject({
      code: 'TOOL_FORBIDDEN',
    });
    await expect(
      tools.ticket(changed, scope.tenantId, signal),
    ).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN' });
  }
  expect(retrieval.search).not.toHaveBeenCalled();
  expect(pool.connect).not.toHaveBeenCalled();
});
test('the catalogue is copied, bounded and rejects ambiguous service ownership', async () => {
  const copy = structuredClone(catalogue),
    tools = new ReadOnlyAgentTools(
      scope,
      { connect: jest.fn() },
      { search: jest.fn() },
      copy,
    );
  copy.services[0].status = 'unavailable';
  const observed = await tools.serviceStatus(scope, 'harbor-api', signal);
  observed.status = 'degraded';
  expect((await tools.serviceStatus(scope, 'harbor-api', signal)).status).toBe(
    'operational',
  );
  expect(
    () =>
      new ReadOnlyAgentTools(
        scope,
        {},
        {},
        {
          ...catalogue,
          services: [catalogue.services[0], catalogue.services[0]],
        },
      ),
  ).toThrow('INVALID_ARGUMENTS');
});
test('retrieval receives only the bound snapshot and approved fixed profile', async () => {
  const retrieval = { search: jest.fn(async () => []) };
  const tools = new ReadOnlyAgentTools(
    scope,
    { connect: jest.fn() },
    retrieval,
    catalogue,
  );
  await tools.search(scope, 'retry policy', signal);
  expect(retrieval.search).toHaveBeenCalledWith({
    ...scope,
    profile: 'lexical-hash-v1',
    policy: 'extractive-simulated-v1',
    query: 'retry policy',
  });
});
test('malformed identifiers and aborted requests do not connect to PostgreSQL', async () => {
  const pool = { connect: jest.fn() },
    tools = new ReadOnlyAgentTools(
      scope,
      pool,
      { search: jest.fn() },
      catalogue,
    );
  await expect(tools.ticket(scope, 'not-a-uuid', signal)).rejects.toMatchObject(
    { code: 'INVALID_ARGUMENTS' },
  );
  await expect(
    tools.serviceStatus(scope, 'https://untrusted.invalid', signal),
  ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
  const controller = new AbortController();
  controller.abort();
  await expect(
    tools.ticket(scope, scope.tenantId, controller.signal),
  ).rejects.toMatchObject({ code: 'ABORTED' });
  expect(pool.connect).not.toHaveBeenCalled();
});
