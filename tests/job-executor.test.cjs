const { JobExecutor } = require('../apps/worker/dist/job-executor.js');
const {
  ExecutionProviderError,
} = require('../apps/worker/dist/job-executor.js');
const {
  ExecutionOwnershipError,
} = require('../apps/worker/dist/execution-ownership.js');
const claim = {
  jobId: 'job',
  attemptId: 'token',
  ticketId: 'ticket',
  tenantId: 'tenant',
  generation: 1,
  attemptNumber: 1,
  leaseExpiresAt: '2026-11-23T00:00:30Z',
};
const result = {
  outcome: 'insufficient_evidence',
  answer: 'No indexed evidence is available in this simulated scenario.',
};
const source = () => ({
  claim: jest.fn().mockResolvedValue(claim),
  renew: jest.fn().mockResolvedValue(true),
  complete: jest.fn().mockResolvedValue(true),
  retry: jest.fn().mockResolvedValue(true),
  fail: jest.fn().mockResolvedValue(true),
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
test('a claimed job executes and persists its result automatically', async () => {
  const store = source(),
    provider = { execute: jest.fn().mockResolvedValue(result) };
  expect(
    await new JobExecutor(store, provider).runOnce(
      new AbortController().signal,
    ),
  ).toBe(true);
  expect(provider.execute).toHaveBeenCalledWith(claim, expect.any(AbortSignal));
  expect(store.complete).toHaveBeenCalledWith(
    claim.jobId,
    claim.attemptId,
    result,
  );
  expect(store.retry).not.toHaveBeenCalled();
  expect(store.fail).not.toHaveBeenCalled();
});
test('an empty queue or pre-aborted run never invokes the provider', async () => {
  const store = source(),
    provider = { execute: jest.fn() };
  store.claim.mockResolvedValue(null);
  expect(
    await new JobExecutor(store, provider).runOnce(
      new AbortController().signal,
    ),
  ).toBe(false);
  store.claim.mockClear();
  expect(
    await new JobExecutor(store, provider).runOnce(AbortSignal.abort()),
  ).toBe(false);
  expect(store.claim).not.toHaveBeenCalled();
  expect(provider.execute).not.toHaveBeenCalled();
});
test('shutdown racing a claim leaves its lease recoverable without starting execution', async () => {
  let claimed;
  const store = source();
  store.claim.mockImplementation(
    () =>
      new Promise((resolve) => {
        claimed = resolve;
      }),
  );
  const provider = { execute: jest.fn() },
    controller = new AbortController();
  const task = new JobExecutor(store, provider).runOnce(controller.signal);
  controller.abort();
  claimed(claim);
  await task;
  expect(provider.execute).not.toHaveBeenCalled();
  expect(store.retry).not.toHaveBeenCalled();
});
test('heartbeats renew every five seconds and stop before completion', async () => {
  let finish;
  const store = source(),
    provider = {
      execute: jest.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    };
  const task = new JobExecutor(store, provider).runOnce(
    new AbortController().signal,
  );
  await jest.advanceTimersByTimeAsync(4999);
  expect(store.renew).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(store.renew).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(5000);
  expect(store.renew).toHaveBeenCalledTimes(2);
  finish(result);
  await task;
  await jest.advanceTimersByTimeAsync(10000);
  expect(store.renew).toHaveBeenCalledTimes(2);
  expect(store.complete).toHaveBeenCalledTimes(1);
});
test.each([false, 'error'])(
  'failed renewal %s interrupts work and never finalizes with uncertain ownership',
  async (mode) => {
    const store = source();
    if (mode === 'error')
      store.renew.mockRejectedValue(new Error('private-renew-detail'));
    else store.renew.mockResolvedValue(false);
    let signal;
    const provider = {
      execute: jest.fn((_claim, value) => {
        signal = value;
        return new Promise(() => {});
      }),
    };
    const task = new JobExecutor(store, provider).runOnce(
      new AbortController().signal,
    );
    await jest.advanceTimersByTimeAsync(5000);
    await task;
    expect(signal.aborted).toBe(true);
    for (const op of ['complete', 'retry', 'fail'])
      expect(store[op]).not.toHaveBeenCalled();
  },
);
test('renewals do not overlap and a ready result waits for ownership confirmation', async () => {
  const store = source();
  let renew, finish;
  store.renew.mockImplementation(
    () =>
      new Promise((resolve) => {
        renew = resolve;
      }),
  );
  const provider = {
    execute: jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const task = new JobExecutor(store, provider).runOnce(
    new AbortController().signal,
  );
  await jest.advanceTimersByTimeAsync(15000);
  expect(store.renew).toHaveBeenCalledTimes(1);
  finish(result);
  await jest.advanceTimersByTimeAsync(0);
  expect(store.complete).not.toHaveBeenCalled();
  renew(false);
  await task;
  expect(store.complete).not.toHaveBeenCalled();
});
test('a sixty-second deadline retries within the durable budget and ignores a late provider answer', async () => {
  const store = source();
  let finish, signal;
  const provider = {
    execute: jest.fn((_claim, value) => {
      signal = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
  };
  const task = new JobExecutor(store, provider).runOnce(
    new AbortController().signal,
  );
  await jest.advanceTimersByTimeAsync(60000);
  await task;
  expect(signal.aborted).toBe(true);
  expect(store.retry).toHaveBeenCalledTimes(1);
  finish(result);
  await jest.advanceTimersByTimeAsync(0);
  expect(store.complete).not.toHaveBeenCalled();
});
test('lost ownership during deadline cleanup takes precedence over retrying a timed-out provider', async () => {
  const store = source();
  let renew;
  store.renew.mockImplementation(
    () =>
      new Promise((resolve) => {
        renew = resolve;
      }),
  );
  const task = new JobExecutor(store, {
    execute: () => new Promise(() => {}),
  }).runOnce(new AbortController().signal);
  await jest.advanceTimersByTimeAsync(60000);
  renew(false);
  await task;
  expect(store.retry).not.toHaveBeenCalled();
  expect(store.fail).not.toHaveBeenCalled();
});
test.each([
  ['retryable', 'retry'],
  ['permanent', 'fail'],
  ['unknown', 'fail'],
])(
  'provider error %s is classified without copying its details',
  async (kind, op) => {
    const store = source(),
      report = jest.fn();
    const error =
      kind === 'unknown'
        ? new Error('private-provider-details')
        : new ExecutionProviderError(kind);
    await new JobExecutor(
      store,
      { execute: jest.fn().mockRejectedValue(error) },
      report,
    ).runOnce(new AbortController().signal);
    expect(store[op]).toHaveBeenCalledTimes(1);
    expect(store.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      'private-provider-details',
    );
  },
);
test('completion uncertainty is not reclassified as a provider failure', async () => {
  const store = source();
  store.complete.mockRejectedValue(
    new ExecutionOwnershipError('DEPENDENCY_UNAVAILABLE'),
  );
  await new JobExecutor(store, {
    execute: jest.fn().mockResolvedValue(result),
  }).runOnce(new AbortController().signal);
  expect(store.retry).not.toHaveBeenCalled();
  expect(store.fail).not.toHaveBeenCalled();
});
test('invalid provider output rejected before SQL becomes a permanent failure', async () => {
  const store = source();
  store.complete.mockImplementation(() => {
    throw new ExecutionOwnershipError('INVALID_REQUEST');
  });
  await new JobExecutor(store, {
    execute: jest.fn().mockResolvedValue({ outcome: 'answered' }),
  }).runOnce(new AbortController().signal);
  expect(store.fail).toHaveBeenCalledTimes(1);
  expect(store.retry).not.toHaveBeenCalled();
});
test('shutdown during provider work abandons the lease and ignores late success', async () => {
  const store = source(),
    controller = new AbortController();
  let finish, signal;
  const task = new JobExecutor(store, {
    execute: (_claim, value) => {
      signal = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  }).runOnce(controller.signal);
  await jest.advanceTimersByTimeAsync(0);
  controller.abort();
  await task;
  finish(result);
  await jest.advanceTimersByTimeAsync(0);
  expect(signal.aborted).toBe(true);
  for (const op of ['complete', 'retry', 'fail'])
    expect(store[op]).not.toHaveBeenCalled();
});
test('the polling runtime never has more than two active provider attempts', async () => {
  const store = source(),
    controller = new AbortController();
  let next = 0;
  store.claim.mockImplementation(async () => ({
    ...claim,
    jobId: `job-${next++}`,
  }));
  const provider = { execute: jest.fn(() => new Promise(() => {})) };
  const running = new JobExecutor(store, provider).run(controller.signal);
  await jest.advanceTimersByTimeAsync(1000);
  expect(provider.execute).toHaveBeenCalledTimes(2);
  expect(store.claim).toHaveBeenCalledTimes(2);
  controller.abort();
  await running;
  expect(store.complete).not.toHaveBeenCalled();
});
