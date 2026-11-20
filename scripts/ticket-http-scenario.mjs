// Trusted test operator: injected into the seed job, never shipped in API images.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';

const mode = process.argv[1];
const manifest = JSON.parse(
  readFileSync('/run/lab/demo/identities/identities-v1.json', 'utf8'),
);
const credential = (alias) =>
  manifest.credentials.find((entry) => entry.alias === alias);
const requester = credential('harbor.requester');
async function post({
  identity = requester,
  key = randomUUID(),
  body = { message: 'Fictional support question' },
  headers = {},
  missing = false,
} = {}) {
  const result = await fetch('http://api:3000/v1/tickets', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...(missing
        ? {}
        : { authorization: `Bearer ${identity.lookupId}.${identity.secret}` }),
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const raw = await result.text();
  for (const entry of manifest.credentials)
    assert.equal(
      raw.includes(entry.secret),
      false,
      'response exposed credential material',
    );
  const decoded = JSON.parse(raw);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(result.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  if (result.status === 202)
    assert.equal(result.headers.get('location'), decoded.statusUrl);
  else {
    assert.equal(decoded.error.requestId, result.headers.get('x-request-id'));
    assert.equal(Object.keys(decoded).join(','), 'error');
  }
  return {
    status: result.status,
    body: decoded,
    retryAfter: result.headers.get('retry-after'),
    requestId: result.headers.get('x-request-id'),
  };
}
if (mode === 'basic') {
  const key = randomUUID();
  const first = await post({ key });
  assert.equal(first.status, 202);
  const repeat = await post({
    key,
    body: { message: '  Fictional support question\n' },
  });
  assert.equal(repeat.status, 202);
  assert.deepEqual(repeat.body, first.body);
  assert.notEqual(repeat.requestId, first.requestId);
  const conflict = await post({ key, body: { message: 'Changed question' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await post({ missing: true })).status, 401);
  assert.equal(
    (await post({ identity: credential('harbor.reader') })).status,
    403,
  );
  assert.equal(
    (
      await post({
        identity: {
          ...requester,
          secret: randomBytes(32).toString('base64url'),
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post({
        body: {
          message: 'Forged tenant',
          tenantId: 'a1000000-0000-4000-8000-000000000002',
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post({
        headers: { 'x-tenant-id': 'a1000000-0000-4000-8000-000000000002' },
      })
    ).status,
    202,
  );
  const other = await post({ identity: credential('summit.requester'), key });
  assert.equal(other.status, 202);
  assert.notEqual(other.body.ticketId, first.body.ticketId);
  const unused = randomUUID();
  assert.equal(
    (await post({ key: unused, body: { message: '  ' } })).status,
    400,
  );
  assert.equal((await post({ key: unused })).status, 202);
} else if (mode === 'idempotency-race') {
  const key = randomUUID();
  const replies = await Promise.all(
    Array.from({ length: 8 }, () => post({ key })),
  );
  for (const reply of replies) {
    assert.equal(reply.status, 202);
    assert.deepEqual(reply.body, replies[0].body);
  }
} else if (mode === 'tenant-limit') {
  const replies = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      post({ headers: { 'x-forwarded-for': `203.0.113.${i}` } }),
    ),
  );
  assert.equal(replies.filter((reply) => reply.status === 202).length, 10);
  assert.equal(replies.filter((reply) => reply.status === 429).length, 14);
  for (const reply of replies.filter((entry) => entry.status === 429)) {
    assert.equal(reply.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(reply.retryAfter) >= 1 && Number(reply.retryAfter) <= 60);
  }
} else if (mode === 'ingress-limit') {
  const statuses = [];
  for (let i = 0; i < 301; i++)
    statuses.push(
      (
        await post({
          missing: true,
          headers: { 'x-forwarded-for': `203.0.113.${i % 255}` },
        })
      ).status,
    );
  assert.equal(statuses.filter((status) => status === 401).length, 300);
  assert.equal(statuses.filter((status) => status === 429).length, 1);
} else if (mode === 'limited') {
  const reply = await post();
  assert.equal(reply.status, 429);
  assert.equal(reply.body.error.code, 'RATE_LIMITED');
} else if (mode === 'unavailable') {
  const reply = await post();
  assert.equal(reply.status, 503);
  assert.equal(reply.body.error.code, 'DEPENDENCY_UNAVAILABLE');
} else if (mode === 'revoked') {
  const reply = await post({ key: 'revocation-retry' });
  assert.equal(reply.status, 401);
  assert.equal(reply.body.error.code, 'UNAUTHENTICATED');
} else if (mode === 'accepted') {
  assert.equal((await post({ key: process.argv[2] })).status, 202);
} else throw new Error('Unknown test scenario');
console.log(JSON.stringify({ event: 'ticket_http_scenario_passed', mode }));
