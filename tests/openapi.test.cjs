const { createOpenApiDocument } = require('../apps/api/dist/openapi');
test('the export describes only the five implemented HTTP route operations', () => {
  const spec = createOpenApiDocument();
  expect(spec.openapi).toBe('3.1.1');
  expect(Object.keys(spec.paths).sort()).toEqual([
    '/health/live',
    '/health/ready',
    '/v1/tickets',
    '/v1/tickets/{ticketId}',
    '/v1/tickets/{ticketId}/replays',
  ]);
});
const { httpSchemas } = require('../apps/api/dist/openapi');
const { createApi } = require('../apps/api/dist/app');
const { TicketAccessError } = require('../apps/api/dist/ticket-access');
const { TicketReadError } = require('../apps/api/dist/ticket-read');
const { TicketSubmissions } = require('../apps/api/dist/ticket-submission');
const { randomUUID } = require('node:crypto');
const id = 'a3000000-0000-4000-8000-000000000001';
const identity = { tenantId: id, principalId: id, role: 'requester' };
const base = {
  ticketId: id,
  generation: 1,
  createdAt: '2026-11-25T00:00:00.000Z',
  updatedAt: '2026-11-25T00:00:00.000Z',
};
const receipt = { ticketId: id, generation: 1, statusUrl: '/v1/tickets/' + id };
let app, url, state;
const headers = {
  authorization: 'Bearer contract-fixture',
  'content-type': 'application/json',
  'idempotency-key': 'contract-key',
};
beforeAll(async () => {
  const validationOnly = new TicketSubmissions({
    connect: async () => {
      throw Error('A contract validation must not connect to SQL');
    },
  });
  const service = {
    async checkIngress() {},
    async authenticate(value) {
      if (value !== headers.authorization)
        throw new TicketAccessError('UNAUTHENTICATED');
      return { ...identity, role: state.role };
    },
    async checkSubmissionLimit() {
      if (state.limited) throw new TicketAccessError('RATE_LIMITED', 7);
    },
    async checkReadLimit() {},
    async submit(input) {
      if (state.validateOnly) return validationOnly.submit(input);
      return receipt;
    },
    async replay() {
      return { ...receipt, generation: 2 };
    },
    async getTicket() {
      if (state.readError) throw state.readError;
      return state.ticket;
    },
  };
  app = await createApi({ isReady: async () => state.ready }, service);
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  state = {
    ready: true,
    role: 'requester',
    ticket: { ...base, status: 'queued', result: null, failure: null },
  };
});
function responseSchema(path, method, status) {
  const operation = createOpenApiDocument().paths[path][method];
  const response = operation.responses[String(status)];
  expect(response).toBeDefined();
  const ref = response.content['application/json'].schema.$ref;
  return httpSchemas[ref.split('/').at(-1)];
}
test('real health routes match their documented public readiness states', async () => {
  for (const [path, ready, status] of [
    ['/health/live', false, 200],
    ['/health/ready', false, 503],
    ['/health/ready', true, 200],
  ]) {
    state.ready = ready;
    const r = await fetch(url + path);
    expect(r.status).toBe(status);
    expect(
      responseSchema(path, 'get', status).safeParse(await r.json()).success,
    ).toBe(true);
    expect(createOpenApiDocument().paths[path].get.security).toEqual([]);
  }
});
test('real acceptance and replay return documented receipts and headers', async () => {
  for (const [path, body, expectedGeneration] of [
    ['/v1/tickets', { message: 'retry policy' }, 1],
    ['/v1/tickets/{ticketId}/replays', { expectedGeneration: 1 }, 2],
  ]) {
    state.role = expectedGeneration === 2 ? 'operator' : 'requester';
    const r = await fetch(url + path.replace('{ticketId}', id), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(202);
    const value = await r.json();
    expect(value.generation).toBe(expectedGeneration);
    expect(responseSchema(path, 'post', 202).safeParse(value).success).toBe(
      true,
    );
    expect(r.headers.get('location')).toBe(value.statusUrl);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
  }
});
const legacy = { providerMode: 'simulated', attemptCount: 1, toolCalls: [] };
const agent = {
  ...legacy,
  policy: 'bounded-agent-v1',
  modelTurns: 2,
  toolCalls: [{ name: 'get_ticket', outcome: 'observed' }],
};
test.each([
  { ...base, status: 'queued', result: null, failure: null },
  { ...base, status: 'processing', result: null, failure: null },
  ...[legacy, agent].map((execution) => ({
    ...base,
    status: 'completed',
    failure: null,
    result: {
      outcome: 'insufficient_evidence',
      answer: 'No indexed support.',
      citations: [],
      execution,
    },
  })),
  {
    ...base,
    status: 'completed',
    failure: null,
    result: {
      outcome: 'answered',
      answer: 'A fictional cited extract.',
      citations: [{ documentId: id, documentVersion: 'v1', chunkId: id }],
      execution: agent,
    },
  },
  {
    ...base,
    status: 'failed',
    result: null,
    failure: { code: 'EXECUTION_FAILED', message: 'Execution failed.' },
  },
])(
  'the real GET serialization matches the documented lifecycle: $status',
  async (ticket) => {
    state.ticket = ticket;
    const r = await fetch(url + '/v1/tickets/' + id, { headers });
    expect(r.status).toBe(200);
    expect(
      responseSchema('/v1/tickets/{ticketId}', 'get', 200).safeParse(
        await r.json(),
      ).success,
    ).toBe(true);
  },
);
test.each([
  ['unauthenticated', 401, 'UNAUTHENTICATED'],
  ['forbidden', 403, 'FORBIDDEN'],
  ['forged-body', 400, 'INVALID_REQUEST'],
  ['media', 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ['oversized', 413, 'PAYLOAD_TOO_LARGE'],
  ['limited', 429, 'RATE_LIMITED'],
])(
  'actual submission errors match declared safe schemas: %s',
  async (mode, status, code) => {
    const h = { ...headers };
    let body = JSON.stringify({ message: 'retry policy' });
    if (mode === 'unauthenticated') delete h.authorization;
    if (mode === 'forbidden') state.role = 'reader';
    if (mode === 'forged-body') {
      state.validateOnly = true;
      body = JSON.stringify({ message: 'retry policy', tenantId: id });
    }
    if (mode === 'media') h['content-type'] = 'text/plain';
    if (mode === 'oversized') body = 'x'.repeat(16385);
    if (mode === 'limited') state.limited = true;
    const r = await fetch(url + '/v1/tickets', {
      method: 'POST',
      headers: h,
      body,
    });
    expect(r.status).toBe(status);
    const value = await r.json();
    expect(value.error.code).toBe(code);
    expect(
      responseSchema('/v1/tickets', 'post', status).safeParse(value).success,
    ).toBe(true);
    expect(value.error.requestId).toBe(r.headers.get('x-request-id'));
    if (mode === 'limited') expect(r.headers.get('retry-after')).toBe('7');
  },
);
test.each([
  [new TicketReadError('NOT_FOUND'), 404],
  [new TicketReadError('DEPENDENCY_UNAVAILABLE'), 503],
  [Error('FAKE_PROVIDER_SECRET'), 500],
])(
  'read error status %s remains documented and sanitized',
  async (error, status) => {
    state.readError = error;
    const r = await fetch(url + '/v1/tickets/' + id, { headers });
    expect(r.status).toBe(status);
    const value = await r.json();
    expect(
      responseSchema('/v1/tickets/{ticketId}', 'get', status).safeParse(value)
        .success,
    ).toBe(true);
    expect(JSON.stringify(value)).not.toContain('FAKE_PROVIDER_SECRET');
  },
);
test('every generated schema reference resolves locally and no unimplemented endpoint is advertised', () => {
  const spec = createOpenApiDocument();
  const ids = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      expect(value.$ref.startsWith('#/components/schemas/')).toBe(true);
      expect(
        spec.components.schemas[value.$ref.split('/').at(-1)],
      ).toBeDefined();
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(spec);
  for (const item of Object.values(spec.paths))
    for (const op of Object.values(item)) ids.push(op.operationId);
  expect(new Set(ids).size).toBe(5);
  expect(spec.security).toEqual([{ BearerAuth: [] }]);
  expect(JSON.stringify(spec)).not.toMatch(
    /\/admin|\/tools|\/upload|apiKey|FAKE_PROVIDER_SECRET/,
  );
});
test('documented server-only invariants reject extra authority and unsafe summaries', () => {
  expect(
    httpSchemas.SubmitBody.safeParse({
      message: 'retry',
      tenantId: randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    httpSchemas.Ticket.safeParse({
      ...base,
      status: 'completed',
      failure: null,
      result: {
        outcome: 'insufficient_evidence',
        answer: 'No support.',
        citations: [],
        execution: {
          ...agent,
          toolCalls: [
            {
              name: 'get_ticket',
              outcome: 'observed',
              arguments: { secret: 'fake' },
            },
          ],
        },
      },
    }).success,
  ).toBe(false);
});
