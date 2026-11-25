const {
  createTelemetry,
  validTraceParent,
} = require('../packages/telemetry/dist');
test('manual spans preserve a valid parent across a detached stage', () => {
  const spans = [];
  const telemetry = createTelemetry('lab-worker', 'executor', (value) => {
    spans.push(value);
    return true;
  });
  const parent = '00-11111111111111111111111111111111-2222222222222222-01';
  const span = telemetry.start('execution.run', parent);
  span.end('completed');
  expect(spans).toHaveLength(1);
  expect(spans[0].traceId).toBe('11111111111111111111111111111111');
  expect(spans[0].parentSpanId).toBe('2222222222222222');
  expect(validTraceParent(span.traceParent)).toBe(span.traceParent);
});
test.each([
  undefined,
  null,
  '',
  'x'.repeat(10000),
  '00-' + '0'.repeat(32) + '-2222222222222222-01',
  '00-11111111111111111111111111111111-' + '0'.repeat(16) + '-01',
  '00-11111111111111111111111111111111-2222222222222222-01\n',
  ['00-11111111111111111111111111111111-2222222222222222-01'],
  '01-11111111111111111111111111111111-2222222222222222-01',
])('invalid optional context is ignored without reflecting it: %j', (value) => {
  expect(validTraceParent(value)).toBeUndefined();
  const spans = [];
  const t = createTelemetry('lab-api', 'api', (x) => {
    spans.push(x);
    return true;
  });
  t.start('http.submit', value).end('accepted');
  expect(spans).toHaveLength(1);
  expect(spans[0].traceId).toMatch(/^[a-f0-9]{32}$/);
  expect(spans[0].parentSpanId).toBeUndefined();
});
test('Kafka Buffer context is bounded, and duplicate array-valued context is ignored', () => {
  const parent = '00-11111111111111111111111111111111-2222222222222222-01';
  expect(validTraceParent(Buffer.from(parent))).toBe(parent);
  expect(validTraceParent([Buffer.from(parent)])).toBeUndefined();
});
test('metadata is allowlisted and malformed IDs, raw errors and excerpts are never exported', () => {
  const spans = [],
    t = createTelemetry('lab-api', 'api', (r) => {
      spans.push(r);
      return true;
    });
  const span = t.start('http.read');
  span.end('observed', {
    ticketId: 'private-secret-fixture',
    requestId: 'a3000000-0000-4000-8000-000000000001',
    generation: 1,
    message: 'private-secret-fixture',
    error: 'private-secret-fixture',
    authorization: 'private-secret-fixture',
  });
  span.end('failed');
  expect(spans).toHaveLength(1);
  expect(JSON.stringify(spans)).not.toContain('private-secret-fixture');
  expect(spans[0].generation).toBe(1);
  expect(Object.keys(spans[0]).sort()).toEqual(
    [
      'event',
      'service',
      'role',
      'stage',
      'traceId',
      'spanId',
      'outcome',
      'durationMs',
      'requestId',
      'generation',
    ].sort(),
  );
});
test('a failing or dropping sink does not throw into business processing or retain a queue', () => {
  for (const sink of [
    () => {
      throw new Error('secret');
    },
    () => false,
  ]) {
    const t = createTelemetry('lab-worker', 'executor', sink);
    for (let i = 0; i < 1000; i++)
      expect(() => t.start('execution.run').end('completed')).not.toThrow();
  }
});
test('independent concurrent roots keep their own child contexts', () => {
  const spans = [],
    t = createTelemetry('lab-worker', 'consumer', (r) => {
      spans.push(r);
      return true;
    });
  const a = t.start('outbox.publish'),
    b = t.start('outbox.publish');
  const ac = t.start('consumer.admit', a.traceParent),
    bc = t.start('consumer.admit', b.traceParent);
  bc.end('scheduled');
  ac.end('scheduled');
  a.end('completed');
  b.end('completed');
  expect(ac.traceId).toBe(a.traceId);
  expect(bc.traceId).toBe(b.traceId);
  expect(a.traceId).not.toBe(b.traceId);
});
test('stdout backpressure drops telemetry before another write can accumulate', () => {
  const { createStreamSink } = require('../packages/telemetry/dist');
  const { Writable } = require('node:stream');
  const write = jest.fn();
  const stream = new Writable({ write });
  stream.write(Buffer.alloc(65536));
  try {
    const sink = createStreamSink(stream);
    for (let i = 0; i < 1000; i++)
      expect(sink({ event: 'trace_span' })).toBe(false);
    expect(stream.writableLength).toBe(65536);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    stream.destroy();
  }
});
test('a stalled exporter has bounded storage and never starts concurrent requests', async () => {
  jest.useFakeTimers();
  const { boundedProcessor } = require('../packages/telemetry/dist');
  let callback;
  const exporter = {
    export: jest.fn((_, cb) => {
      callback = cb;
    }),
    shutdown: async () => {},
  };
  const processor = boundedProcessor(exporter, 100);
  try {
    for (let i = 0; i < 1000; i++) processor.onEnd({});
    expect(processor.statistics()).toEqual({
      queued: 128,
      inFlight: 0,
      dropped: 872,
      failures: 0,
    });
    jest.advanceTimersByTime(1000);
    expect(exporter.export).toHaveBeenCalledTimes(1);
    expect(processor.statistics()).toEqual({
      queued: 96,
      inFlight: 1,
      dropped: 872,
      failures: 1,
    });
    for (let i = 0; i < 1000; i++) processor.onEnd({});
    expect(processor.statistics().queued).toBe(128);
    callback({ code: 0 });
    jest.advanceTimersByTime(200);
    expect(exporter.export).toHaveBeenCalledTimes(2);
    callback({ code: 0 });
    await processor.shutdown();
    expect(processor.statistics().queued).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
test('synchronous exporter failures are isolated and counted', async () => {
  const { boundedProcessor } = require('../packages/telemetry/dist');
  const processor = boundedProcessor({
    export: () => {
      throw Error('secret');
    },
    shutdown: async () => {},
  });
  processor.onEnd({});
  await expect(processor.forceFlush()).resolves.toBeUndefined();
  expect(processor.statistics().failures).toBe(1);
  await processor.shutdown();
});
test('export shutdown returns within its deadline even when the exporter never resolves', async () => {
  jest.useFakeTimers();
  const { boundedProcessor } = require('../packages/telemetry/dist');
  const processor = boundedProcessor(
    { export: () => {}, shutdown: () => new Promise(() => {}) },
    100,
  );
  try {
    processor.onEnd({});
    const shutdown = processor.shutdown();
    jest.advanceTimersByTime(100);
    await expect(shutdown).resolves.toBeUndefined();
    expect(processor.statistics().queued).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
