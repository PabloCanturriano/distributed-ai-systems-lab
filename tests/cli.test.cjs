const { runCli } = require('../apps/cli/dist/cli');
const id = 'a3000000-0000-4000-8000-000000000001';
const receipt = { ticketId: id, generation: 1, statusUrl: `/v1/tickets/${id}` };
const credential = { lookupId: id, secret: 's'.repeat(43) };
test('create retains one generated idempotency key after a lost acknowledgement', async () => {
  const fetch = jest
    .fn()
    .mockRejectedValueOnce(new Error('private transport data'))
    .mockResolvedValueOnce(
      new Response(JSON.stringify(receipt), { status: 202 }),
    );
  const result = await runCli(
    ['ticket', 'create', '--message', 'private question', '--json'],
    {
      credential: async () => credential,
      fetch,
      key: () => 'stable-key',
      delay: async () => {},
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).toMatchObject({
    schemaVersion: 1,
    outcome: 'accepted',
    key: 'stable-key',
    ticket: receipt,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url, options] of fetch.mock.calls) {
    expect(url).toBe('http://api:3000/v1/tickets');
    expect(options.headers['idempotency-key']).toBe('stable-key');
    expect(options.body).toBe(JSON.stringify({ message: 'private question' }));
    expect(options.redirect).toBe('manual');
  }
  expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.stringify(result)).not.toContain(credential.secret);
});
const queued = {
  ticketId: id,
  generation: 1,
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
  status: 'queued',
  result: null,
  failure: null,
};
const completed = {
  ...queued,
  status: 'completed',
  result: {
    outcome: 'insufficient_evidence',
    answer: 'Simulated abstention.',
    citations: [],
    execution: { providerMode: 'simulated', attemptCount: 1, toolCalls: [] },
  },
};
const response = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const deps = (fetch) => ({
  credential: jest.fn(async () => credential),
  fetch,
  key: () => 'stable-key',
  delay: async () => {},
});
test.each(
  [
    [],
    ['ticket', 'replay', id],
    ['ticket', 'get', 'not-an-id'],
    ['ticket', 'create', '--message', ' '],
    ['ticket', 'create', '--message', 'x', '--key', 'bad key'],
    ['ticket', 'get', id, '--endpoint', 'https://untrusted.invalid'],
    ['ticket', 'get', id, '--identity', 'unknown'],
    ['ticket', 'get', id, '--deadline', '0'],
    ['ticket', 'get', id, '--deadline', '301'],
    ['ticket', 'get', id, '--deadline', '1.5'],
    [
      'ticket',
      'get',
      id,
      '--identity',
      'harbor.reader',
      '--identity',
      'summit.reader',
    ],
    ['ticket', 'get', id, '--message', 'private'],
    ['demo', 'extra'],
    ['ticket', 'create', '--message', 'x'.repeat(4001)],
    ['ticket', 'create', '--message', '\ud800'],
  ].map((args) => [args]),
)(
  'invalid arguments fail before reading credentials or sending HTTP: %j',
  async (args) => {
    const d = deps(jest.fn());
    const r = await runCli(args, d);
    expect(r.exitCode).toBe(2);
    expect(r.output.error.code).toBe('INVALID_ARGUMENTS');
    expect(d.credential).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  },
);
test('help succeeds without credentials and only advertises implemented commands', async () => {
  const d = deps(jest.fn());
  const r = await runCli(['--help'], d);
  expect(r.exitCode).toBe(0);
  expect(r.output.outcome).toBe('help');
  expect(d.credential).not.toHaveBeenCalled();
});
test('missing credentials retain the generated key without exposing filesystem errors', async () => {
  const d = deps(jest.fn());
  d.credential.mockRejectedValue(new Error('private path'));
  const r = await runCli(['ticket', 'create', '--message', 'x'], d);
  expect(r.exitCode).toBe(3);
  expect(r.output.key).toBe('stable-key');
  expect(JSON.stringify(r)).not.toContain('private');
});
test('wait polls to a terminal simulated result and progress stays separate', async () => {
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(response(queued))
    .mockResolvedValueOnce(response({ ...queued, status: 'processing' }))
    .mockResolvedValueOnce(response(completed));
  const progress = jest.fn();
  const d = { ...deps(fetch), progress };
  const r = await runCli(
    ['ticket', 'wait', id, '--identity', 'harbor.reader', '--json'],
    d,
  );
  expect(r.exitCode).toBe(0);
  expect(r.output.outcome).toBe('completed');
  expect(r.output.ticket).toEqual(completed);
  expect(progress.mock.calls).toEqual([['queued'], ['processing']]);
  expect(d.credential).toHaveBeenCalledWith('harbor.reader');
});
test('demo submits through HTTP and waits; accepted alone is not completed', async () => {
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(response(receipt, 202))
    .mockResolvedValueOnce(response(completed));
  const r = await runCli(['demo', '--json'], deps(fetch));
  expect(r.exitCode).toBe(0);
  expect(r.output.command).toBe('demo');
  expect(r.output.outcome).toBe('completed');
  expect(fetch.mock.calls.map(([, x]) => x.method)).toEqual(['POST', 'GET']);
});
test('overall deadline distinguishes a queued ticket from transport failure', async () => {
  let time = 0;
  const fetch = jest.fn(async () => response(queued));
  const r = await runCli(['ticket', 'wait', id, '--deadline', '2'], {
    ...deps(fetch),
    now: () => time,
    delay: async (ms) => {
      time += ms;
    },
  });
  expect(r.exitCode).toBe(5);
  expect(r.output.error.code).toBe('DEADLINE_EXCEEDED');
  expect(r.output.ticket.status).toBe('queued');
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('per-request transport failure retries at most twice', async () => {
  const fetch = jest
    .fn()
    .mockRejectedValue(new Error('private raw transport error'));
  const r = await runCli(['ticket', 'get', id], deps(fetch));
  expect(r.exitCode).toBe(4);
  expect(r.output.error.code).toBe('TRANSPORT_UNAVAILABLE');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(r)).not.toContain('private');
});
test('503 respects bounded Retry-After with the same request key', async () => {
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(response({}, 503, { 'retry-after': '2' }))
    .mockResolvedValueOnce(response(receipt, 202));
  const delay = jest.fn(async () => {});
  const r = await runCli(['ticket', 'create', '--message', 'x'], {
    ...deps(fetch),
    delay,
  });
  expect(r.exitCode).toBe(0);
  expect(delay).toHaveBeenCalledWith(2000);
  expect(fetch.mock.calls[1][1].headers['idempotency-key']).toBe('stable-key');
});
test('an excessive Retry-After does not retry sooner than requested', async () => {
  const fetch = jest.fn(async () => response({}, 503, { 'retry-after': '60' }));
  const r = await runCli(['ticket', 'get', id], deps(fetch));
  expect(r.exitCode).toBe(4);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test.each([
  [401, 'UNAUTHENTICATED', 3],
  [403, 'FORBIDDEN', 3],
  [404, 'NOT_FOUND', 2],
  [409, 'IDEMPOTENCY_CONFLICT', 2],
  [429, 'RATE_LIMITED', 2],
  [500, 'INTERNAL_ERROR', 4],
])(
  'HTTP %s preserves safe code and never echoes raw errors or retries',
  async (status, code, exit) => {
    const fetch = jest.fn(async () =>
      response(
        {
          error: {
            code,
            message: 'private upstream details',
            requestId: 'bad',
          },
        },
        status,
      ),
    );
    const r = await runCli(['ticket', 'get', id], deps(fetch));
    expect(r.exitCode).toBe(exit);
    expect(r.output.error.code).toBe(code);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain('private');
  },
);
test.each([301, 302, 307, 308])(
  'redirect %s is never followed or used as a status URL',
  async (status) => {
    const fetch = jest.fn(
      async () =>
        new Response(null, {
          status,
          headers: { location: 'https://untrusted.invalid' },
        }),
    );
    const r = await runCli(['ticket', 'get', id], deps(fetch));
    expect(r.exitCode).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].redirect).toBe('manual');
  },
);
test.each([
  { ...receipt, statusUrl: 'https://untrusted.invalid' },
  { ...receipt, generation: 0 },
])('malformed acceptance cannot cause follow-up requests', async (value) => {
  const fetch = jest.fn(async () => response(value, 202));
  const r = await runCli(['demo'], deps(fetch));
  expect(r.exitCode).toBe(4);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test.each([
  { ...completed, ticketId: 'a3000000-0000-4000-8000-000000000002' },
  {
    ...completed,
    result: {
      ...completed.result,
      execution: { ...completed.result.execution, providerMode: 'real' },
    },
  },
  { ...completed, result: { ...completed.result, citations: [{}] } },
  { ...queued, status: 'completed' },
])('unsupported results fail closed', async (value) => {
  const r = await runCli(
    ['ticket', 'get', id],
    deps(jest.fn(async () => response(value))),
  );
  expect(r.exitCode).toBe(4);
  expect(r.output.error.code).toBe('INVALID_RESPONSE');
});
test('unknown API fields are omitted and selected credentials cannot be echoed', async () => {
  const r = await runCli(
    ['ticket', 'get', id],
    deps(
      jest.fn(async () =>
        response({
          ...completed,
          private: 'raw data',
          result: { ...completed.result, raw: 'provider data' },
        }),
      ),
    ),
  );
  expect(r.exitCode).toBe(0);
  expect(JSON.stringify(r)).not.toContain('raw');
  expect(JSON.stringify(r)).not.toContain('provider data');
  const bad = await runCli(
    ['ticket', 'get', id],
    deps(
      jest.fn(async () =>
        response({
          ...completed,
          result: { ...completed.result, answer: credential.secret },
        }),
      ),
    ),
  );
  expect(bad.exitCode).toBe(4);
  expect(JSON.stringify(bad)).not.toContain(credential.secret);
});
test('failed execution is observable through get but fails wait with exit 1', async () => {
  const failed = {
    ...queued,
    status: 'failed',
    failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'private' },
    result: null,
  };
  const d = () => deps(jest.fn(async () => response(failed)));
  expect((await runCli(['ticket', 'get', id], d())).exitCode).toBe(0);
  const r = await runCli(['ticket', 'wait', id], d());
  expect(r.exitCode).toBe(1);
  expect(r.output.error.code).toBe('ATTEMPTS_EXHAUSTED');
  expect(JSON.stringify(r)).not.toContain('private');
});
test('cancellation prevents requests and preserves safe output', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = jest.fn();
  const r = await runCli(['demo'], {
    ...deps(fetch),
    signal: controller.signal,
  });
  expect(r.exitCode).toBe(4);
  expect(r.output.error.code).toBe('INTERRUPTED');
  expect(fetch).not.toHaveBeenCalled();
});
test('oversized and invalid JSON responses are bounded and rejected', async () => {
  for (const raw of ['x'.repeat(32769), '{']) {
    const r = await runCli(
      ['ticket', 'get', id],
      deps(jest.fn(async () => new Response(raw))),
    );
    expect(r.exitCode).toBe(4);
    expect(r.output.error.code).toBe('INVALID_RESPONSE');
  }
});

test('UUID arguments normalize before requesting and validating the server projection', async () => {
  const fetch = jest.fn(async () => response(queued));
  const r = await runCli(['ticket', 'get', id.toUpperCase()], deps(fetch));
  expect(r.exitCode).toBe(0);
  expect(fetch.mock.calls[0][0]).toBe(`http://api:3000/v1/tickets/${id}`);
});
test.each([
  ['--identity=harbor.reader', '--identity=summit.reader'],
  ['--identity', 'harbor.reader', '--identity=summit.reader'],
])(
  'alternate option syntax cannot replace the selected identity: %j',
  async (...options) => {
    const d = deps(jest.fn());
    const r = await runCli(['ticket', 'get', id, ...options], d);
    expect(r.exitCode).toBe(2);
    expect(d.credential).not.toHaveBeenCalled();
  },
);
