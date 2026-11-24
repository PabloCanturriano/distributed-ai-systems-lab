const { randomUUID } = require('node:crypto');
const { createApi } = require('../apps/api/dist/app.js');
const { TicketAccessError } = require('../apps/api/dist/ticket-access.js');
const {
  TicketSubmissionError,
} = require('../apps/api/dist/ticket-submission.js');
const { request: httpRequest } = require('node:http');
const { TicketReadError } = require('../apps/api/dist/ticket-read.js');

test.each([
  [new TicketReadError('NOT_FOUND'), 404, 'NOT_FOUND'],
  [new TicketReadError('INVALID_REQUEST'), 400, 'INVALID_REQUEST'],
  [
    new TicketReadError('DEPENDENCY_UNAVAILABLE'),
    503,
    'DEPENDENCY_UNAVAILABLE',
  ],
  [new Error('fictional-private-read-detail'), 500, 'INTERNAL_ERROR'],
])(
  'read failures preserve the safe response contract: %s',
  async (error, status, code) => {
    await fixture(
      {
        async checkReadLimit() {},
        async getTicket() {
          throw error;
        },
      },
      async (url) => {
        const response = await fetch(`${url}/v1/tickets/${randomUUID()}`);
        expect(response.status).toBe(status);
        const body = await response.json();
        expect(body.error.code).toBe(code);
        expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(JSON.stringify(body)).not.toContain('fictional-private');
      },
    );
  },
);
test('read requests enforce authentication and principal limits before lookup', async () => {
  for (const failure of [
    new TicketAccessError('UNAUTHENTICATED'),
    new TicketAccessError('RATE_LIMITED', 7),
  ]) {
    let lookedUp = false;
    await fixture(
      {
        async authenticate() {
          if (failure.code === 'UNAUTHENTICATED') throw failure;
          return {
            tenantId: randomUUID(),
            principalId: randomUUID(),
            role: 'reader',
          };
        },
        async checkReadLimit() {
          throw failure;
        },
        async getTicket() {
          lookedUp = true;
        },
      },
      async (url) => {
        const response = await fetch(`${url}/v1/tickets/${randomUUID()}`);
        expect(response.status).toBe(
          failure.code === 'UNAUTHENTICATED' ? 401 : 429,
        );
        expect(lookedUp).toBe(false);
      },
    );
  }
});

test('a reader can follow the receipt URL and receive the queued ticket with safe headers', async () => {
  const ticketId = randomUUID();
  const identity = {
    tenantId: randomUUID(),
    principalId: randomUUID(),
    role: 'reader',
  };
  const ticket = {
    ticketId,
    generation: 1,
    status: 'queued',
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    result: null,
    failure: null,
  };
  const service = {
    async checkIngress() {},
    async authenticate() {
      return identity;
    },
    async checkReadLimit(value) {
      expect(value).toEqual(identity);
    },
    async getTicket(value, id) {
      expect(value).toEqual(identity);
      expect(id).toBe(ticketId);
      return ticket;
    },
  };
  const app = await createApi(undefined, service);
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(
      `${await app.getUrl()}/v1/tickets/${ticketId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ticket);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    await app.close();
  }
});

test('authenticated ticket submission returns a stable acceptance receipt and safe headers', async () => {
  const ticketId = randomUUID();
  const identity = {
    tenantId: randomUUID(),
    principalId: randomUUID(),
    role: 'requester',
  };
  const calls = [];
  const service = {
    async checkIngress(peer) {
      calls.push(['ingress', peer]);
    },
    async authenticate(value) {
      expect(value).toBe('Bearer fictional-credential');
      return identity;
    },
    async checkSubmissionLimit(value) {
      expect(value).toEqual(identity);
    },
    async submit(command) {
      calls.push(['submit', command]);
      return { ticketId, generation: 1, statusUrl: `/v1/tickets/${ticketId}` };
    },
  };
  const app = await createApi(undefined, service);
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/v1/tickets`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer fictional-credential',
        'content-type': 'application/json',
        'idempotency-key': 'first-request',
        'x-forwarded-for': '203.0.113.1',
      },
      body: JSON.stringify({ message: 'Fictional question' }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ticketId,
      generation: 1,
      statusUrl: `/v1/tickets/${ticketId}`,
    });
    expect(response.headers.get('location')).toBe(`/v1/tickets/${ticketId}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]).toEqual(['ingress', '127.0.0.1']);
    expect(calls[1][1]).toEqual({
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      requestId: response.headers.get('x-request-id'),
      key: 'first-request',
      body: { message: 'Fictional question' },
    });
  } finally {
    await app.close();
  }
});

async function fixture(overrides, action) {
  let submissions = 0;
  const id = randomUUID();
  const service = {
    async checkIngress() {},
    async authenticate() {
      return {
        tenantId: randomUUID(),
        principalId: randomUUID(),
        role: 'requester',
      };
    },
    async checkSubmissionLimit() {},
    async submit() {
      submissions++;
      return { ticketId: id, generation: 1, statusUrl: `/v1/tickets/${id}` };
    },
    ...overrides,
  };
  const app = await createApi(undefined, service);
  try {
    await app.listen(0, '127.0.0.1');
    await action(await app.getUrl(), () => submissions);
  } finally {
    await app.close();
  }
}
function raw(
  url,
  { headers = {}, body = '', chunked = false, path = '/v1/tickets' } = {},
) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${url}${path}`,
      { method: 'POST', headers },
      (response) => {
        const chunks = [];
        response.on('data', (data) => chunks.push(data));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    request.on('error', reject);
    if (chunked) {
      request.write(body);
      request.end();
    } else request.end(body);
  });
}

test.each([
  [
    {
      authenticate: async () => {
        throw new TicketAccessError('UNAUTHENTICATED');
      },
    },
    401,
    'UNAUTHENTICATED',
  ],
  [{ authenticate: async () => ({ role: 'reader' }) }, 403, 'FORBIDDEN'],
  [
    {
      checkIngress: async () => {
        throw new TicketAccessError('DEPENDENCY_UNAVAILABLE');
      },
    },
    503,
    'DEPENDENCY_UNAVAILABLE',
  ],
  [
    {
      checkSubmissionLimit: async () => {
        throw new TicketAccessError('RATE_LIMITED', 12);
      },
    },
    429,
    'RATE_LIMITED',
  ],
  [
    {
      submit: async () => {
        throw new TicketSubmissionError('IDEMPOTENCY_CONFLICT');
      },
    },
    409,
    'IDEMPOTENCY_CONFLICT',
  ],
  [
    {
      authenticate: async () => {
        throw new Error('fixture-private-database-detail');
      },
    },
    500,
    'INTERNAL_ERROR',
  ],
])(
  'known failures have safe bodies/headers: %s',
  async (overrides, status, code) => {
    await fixture(overrides, async (url) => {
      const result = await raw(url, {
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'key',
        },
        body: '{"message":"test"}',
      });
      expect(result.status).toBe(status);
      expect(result.body.error.code).toBe(code);
      expect(result.body.error.requestId).toBe(result.headers['x-request-id']);
      expect(JSON.stringify(result.body)).not.toContain('fixture-private');
      expect(result.headers['cache-control']).toBe('no-store');
      if (status === 401)
        expect(result.headers['www-authenticate']).toBe('Bearer');
      if (status === 429) expect(result.headers['retry-after']).toBe('12');
      if (status === 503) expect(result.headers['retry-after']).toBe('1');
    });
  },
);

test.each([
  [{ 'content-type': 'text/plain' }, 'text', 415],
  [
    { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    '{}',
    415,
  ],
  [{ 'content-type': 'application/json' }, '{broken', 400],
  [{ 'content-type': 'application/json' }, Buffer.from([255]), 400],
  [{ 'content-type': 'application/json' }, 'x'.repeat(16385), 413],
])(
  'invalid transport body never reaches submission: %s',
  async (headers, body, status) => {
    await fixture({}, async (url, count) => {
      expect((await raw(url, { headers, body, chunked: true })).status).toBe(
        status,
      );
      expect(count()).toBe(0);
    });
  },
);

test('Content-Length bound and duplicate security headers reject before submission', async () => {
  await fixture({}, async (url, count) => {
    expect(
      (
        await raw(url, {
          headers: {
            'content-type': 'application/json',
            'content-length': '20000',
          },
          body: '{}',
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await raw(url, {
          headers: {
            authorization: ['Bearer first', 'Bearer second'],
            'content-type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await raw(url, {
          headers: {
            'idempotency-key': ['first', 'second'],
            'content-type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(count()).toBe(0);
  });
});

test('an unfinished body has a deadline and does not submit', async () => {
  await fixture({}, async (url, count) => {
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest(
        `${url}/v1/tickets`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            request.destroy();
            resolve(response.statusCode);
          });
        },
      );
      request.on('error', reject);
      request.write('{');
    });
    expect(result).toBe(400);
    expect(count()).toBe(0);
  });
});

test('standalone mode rejects business writes instead of granting fallback access', async () => {
  const app = await createApi();
  try {
    await app.listen(0, '127.0.0.1');
    expect((await raw(await app.getUrl(), { body: '{}' })).status).toBe(503);
  } finally {
    await app.close();
  }
});
const { TicketReplayError } = require('../apps/api/dist/ticket-replay');
test('operator replay uses server identity, a fresh request ID, bounded body and the route ticket', async () => {
  const identity = {
      tenantId: randomUUID(),
      principalId: randomUUID(),
      role: 'operator',
    },
    id = randomUUID(),
    key = randomUUID();
  let called = 0;
  await fixture(
    {
      authenticate: async () => identity,
      checkSubmissionLimit: async (value) => expect(value).toEqual(identity),
      replay: async (input) => {
        called++;
        expect(input).toMatchObject({
          tenantId: identity.tenantId,
          principalId: identity.principalId,
          ticketId: id,
          key,
          body: { expectedGeneration: 1 },
        });
        expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
        return { ticketId: id, generation: 2, statusUrl: `/v1/tickets/${id}` };
      },
    },
    async (url) => {
      const r = await fetch(`${url}/v1/tickets/${id}/replays`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ expectedGeneration: 1 }),
      });
      expect(r.status).toBe(202);
      expect(r.headers.get('location')).toBe(`/v1/tickets/${id}`);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect((await r.json()).generation).toBe(2);
      expect(called).toBe(1);
    },
  );
});
test.each(['reader', 'requester'])(
  '%s cannot replay even with a valid-looking body',
  async (role) => {
    const replay = jest.fn();
    await fixture(
      {
        authenticate: async () => ({
          tenantId: randomUUID(),
          principalId: randomUUID(),
          role,
        }),
        replay,
      },
      async (url) => {
        const r = await fetch(`${url}/v1/tickets/${randomUUID()}/replays`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"expectedGeneration":1}',
        });
        expect(r.status).toBe(403);
        expect(replay).not.toHaveBeenCalled();
      },
    );
  },
);
test.each([
  ['NOT_FOUND', 404],
  ['REPLAY_CONFLICT', 409],
  ['IDEMPOTENCY_CONFLICT', 409],
  ['INVALID_REQUEST', 400],
  ['DEPENDENCY_UNAVAILABLE', 503],
])('replay %s preserves safe code and headers', async (code, status) => {
  await fixture(
    {
      authenticate: async () => ({
        tenantId: randomUUID(),
        principalId: randomUUID(),
        role: 'operator',
      }),
      replay: async () => {
        throw new TicketReplayError(code);
      },
    },
    async (url) => {
      const r = await fetch(`${url}/v1/tickets/${randomUUID()}/replays`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"expectedGeneration":1}',
      });
      expect(r.status).toBe(status);
      const b = await r.json();
      expect(b.error.code).toBe(code);
      expect(b.error.requestId).toBe(r.headers.get('x-request-id'));
      expect(r.headers.get('cache-control')).toBe('no-store');
    },
  );
});
test('replay limits run before body parsing or SQL mutation', async () => {
  const replay = jest.fn();
  await fixture(
    {
      authenticate: async () => ({
        tenantId: randomUUID(),
        principalId: randomUUID(),
        role: 'operator',
      }),
      checkSubmissionLimit: async () => {
        throw new TicketAccessError('RATE_LIMITED', 4);
      },
      replay,
    },
    async (url) => {
      const r = await fetch(`${url}/v1/tickets/${randomUUID()}/replays`, {
        method: 'POST',
        body: 'malformed',
      });
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).toBe('4');
      expect(replay).not.toHaveBeenCalled();
    },
  );
});
test('replay authentication failure precedes mutation limits and body parsing', async () => {
  const replay = jest.fn(),
    checkSubmissionLimit = jest.fn();
  await fixture(
    {
      authenticate: async () => {
        throw new TicketAccessError('UNAUTHENTICATED');
      },
      checkSubmissionLimit,
      replay,
    },
    async (url) => {
      const r = await fetch(`${url}/v1/tickets/${randomUUID()}/replays`, {
        method: 'POST',
        body: 'malformed',
      });
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe('Bearer');
      expect(checkSubmissionLimit).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
    },
  );
});
test.each([
  [{ 'content-type': 'text/plain' }, '{}', 415],
  [{ 'content-type': 'application/json' }, '{', 400],
  [
    { 'content-type': 'application/json', 'content-length': '20000' },
    '{}',
    413,
  ],
])('replay preserves HTTP body/media bounds', async (headers, body, status) => {
  const replay = jest.fn();
  await fixture(
    {
      authenticate: async () => ({
        tenantId: randomUUID(),
        principalId: randomUUID(),
        role: 'operator',
      }),
      replay,
    },
    async (url) => {
      const r = await raw(url, {
        path: `/v1/tickets/${randomUUID()}/replays`,
        headers,
        body,
        chunked: false,
      });
      expect(r.status).toBe(status);
      expect(replay).not.toHaveBeenCalled();
    },
  );
});
test('replay rejects duplicate authorization and idempotency headers before mutation', async () => {
  const replay = jest.fn();
  await fixture(
    {
      authenticate: async () => ({
        tenantId: randomUUID(),
        principalId: randomUUID(),
        role: 'operator',
      }),
      replay,
    },
    async (url) => {
      const path = `/v1/tickets/${randomUUID()}/replays`;
      for (const [headers, status] of [
        [{ authorization: ['Bearer first', 'Bearer second'] }, 401],
        [{ 'idempotency-key': ['first', 'second'] }, 400],
      ]) {
        const r = await raw(url, {
          path,
          headers: { ...headers, 'content-type': 'application/json' },
          body: '{"expectedGeneration":1}',
        });
        expect(r.status).toBe(status);
      }
      expect(replay).not.toHaveBeenCalled();
    },
  );
});
