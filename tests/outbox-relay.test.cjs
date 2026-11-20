const { randomUUID, createHash } = require('node:crypto');
const { OutboxRelay } = require('../apps/worker/dist/outbox-relay.js');
const {
  OutboxPublicationError,
} = require('../apps/worker/dist/outbox-publications.js');
function claim(type = 'ticket.execution.requested') {
  const eventId = randomUUID(),
    ticketId = randomUUID(),
    correlationId = randomUUID();
  const payload = JSON.stringify({
    eventId,
    ticketId,
    tenantId: randomUUID(),
    generation: 1,
    type,
    version: 1,
    occurredAt: '2026-11-20T00:00:00.000Z',
    correlationId,
    causationId: correlationId,
    data:
      type === 'ticket.execution.requested'
        ? { reason: 'submitted' }
        : { failureCode: 'EXECUTION_FAILED', attemptCount: 1 },
  });
  return {
    eventId,
    ticketId,
    type,
    version: 1,
    payload,
    payloadDigest: createHash('sha256').update(payload).digest(),
    token: randomUUID(),
  };
}
function source(claims = [claim()]) {
  return {
    claim: jest.fn().mockResolvedValue(claims),
    isCurrent: jest.fn().mockResolvedValue(true),
    acknowledge: jest.fn().mockResolvedValue(true),
    retry: jest.fn().mockResolvedValue(true),
  };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
test('an unresponsive publisher has a complete deadline and cannot acknowledge after a late result', async () => {
  const store = source();
  let finish, signal;
  const publisher = {
    publish(message, value) {
      signal = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const pending = new OutboxRelay(store, publisher).publishBatch();
  await jest.advanceTimersByTimeAsync(10000);
  expect(await pending).toMatchObject({ published: 0, retryable: 1 });
  expect(signal.aborted).toBe(true);
  expect(store.acknowledge).not.toHaveBeenCalled();
  finish();
  await Promise.resolve();
  expect(store.acknowledge).not.toHaveBeenCalled();
});
test('shutdown interrupts the current publication and leaves unstarted claims recoverable', async () => {
  const store = source([claim(), claim()]);
  const controller = new AbortController();
  let began;
  const ready = new Promise((resolve) => {
    began = resolve;
  });
  const publisher = {
    publish() {
      began();
      return new Promise(() => {});
    },
  };
  const pending = new OutboxRelay(store, publisher).publishBatch(
    20,
    controller.signal,
  );
  await ready;
  controller.abort();
  expect(await pending).toMatchObject({
    claimed: 2,
    published: 0,
    retryable: 1,
    deferred: 1,
  });
  expect(store.acknowledge).not.toHaveBeenCalled();
});
test('already-aborted batches do not claim work', async () => {
  const store = source();
  const controller = new AbortController();
  controller.abort();
  expect(
    await new OutboxRelay(store, { publish: jest.fn() }).publishBatch(
      20,
      controller.signal,
    ),
  ).toMatchObject({ claimed: 0 });
  expect(store.claim).not.toHaveBeenCalled();
});
test('stale claims are not sent to the publisher', async () => {
  const store = source();
  store.isCurrent.mockResolvedValue(false);
  const publish = jest.fn();
  expect(
    await new OutboxRelay(store, { publish }).publishBatch(),
  ).toMatchObject({ stale: 1, published: 0 });
  expect(publish).not.toHaveBeenCalled();
});
test('SQL marking errors after publisher acceptance are not misclassified as publication failures', async () => {
  const store = source();
  store.acknowledge.mockRejectedValue(
    new OutboxPublicationError('DEPENDENCY_UNAVAILABLE'),
  );
  await expect(
    new OutboxRelay(store, { async publish() {} }).publishBatch(),
  ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  expect(store.retry).not.toHaveBeenCalled();
});
test('terminal notification events use the separate failure topic', async () => {
  const event = claim('ticket.execution.failed');
  const store = source([event]);
  const publish = jest.fn().mockResolvedValue();
  expect(
    await new OutboxRelay(store, { publish }).publishBatch(),
  ).toMatchObject({ published: 1 });
  expect(publish.mock.calls[0][0].topic).toBe('tickets.execution-failed.v1');
});
