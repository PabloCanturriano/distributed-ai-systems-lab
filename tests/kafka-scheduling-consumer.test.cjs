let client, handler;
jest.mock('@confluentinc/kafka-javascript', () => ({
  KafkaJS: {
    logLevel: { NOTHING: 0 },
    ErrorCodes: { ERR__ASSIGN_PARTITIONS: -175 },
    Kafka: class {
      consumer() {
        return client;
      }
    },
  },
}));
const {
  KafkaSchedulingConsumer,
} = require('../apps/worker/dist/kafka-scheduling-consumer.js');
const payload = (offset = '0') => ({
  topic: 'tickets.execution-requested.v1',
  partition: 0,
  message: { offset, key: Buffer.from('key'), value: Buffer.from('value') },
});
beforeEach(() => {
  client = {
    connect: jest.fn().mockResolvedValue(),
    subscribe: jest.fn().mockResolvedValue(),
    run: jest.fn(async (options) => {
      handler = options.eachMessage;
    }),
    commitOffsets: jest.fn().mockResolvedValue(),
    disconnect: jest.fn().mockResolvedValue(),
  };
  handler = undefined;
});
test('a delivery is not committed before its SQL admission resolves', async () => {
  let admitted;
  const admission = {
    admit: jest.fn(
      () =>
        new Promise((resolve) => {
          admitted = resolve;
        }),
    ),
  };
  const controller = new AbortController();
  const consumer = new KafkaSchedulingConsumer(
    { host: 'kafka', port: 9092 },
    admission,
  );
  const running = consumer.run(controller.signal);
  while (!handler) await new Promise((resolve) => setImmediate(resolve));
  const delivered = handler(payload());
  await new Promise((resolve) => setImmediate(resolve));
  expect(client.commitOffsets).not.toHaveBeenCalled();
  admitted({ disposition: 'scheduled' });
  await delivered;
  expect(client.commitOffsets).toHaveBeenCalledWith([
    { topic: 'tickets.execution-requested.v1', partition: 0, offset: '1' },
  ]);
  controller.abort();
  await running;
});

const {
  SchedulingAdmissionError,
} = require('../apps/worker/dist/scheduling-admissions.js');
const checkpoint = async () => {
  while (!handler) await new Promise((resolve) => setImmediate(resolve));
};
afterEach(() => jest.useRealTimers());
test('a failed admission blocks another callback until the earlier record is durable', async () => {
  const admissions = {
    admit: jest
      .fn()
      .mockRejectedValueOnce(
        new SchedulingAdmissionError('DEPENDENCY_UNAVAILABLE'),
      )
      .mockResolvedValue({ disposition: 'scheduled' }),
  };
  const controller = new AbortController();
  const consumer = new KafkaSchedulingConsumer(
    { host: 'kafka', port: 9092 },
    admissions,
  );
  const running = consumer.run(controller.signal);
  await checkpoint();
  jest.useFakeTimers();
  const first = handler(payload('0')),
    second = handler(payload('1'));
  await jest.advanceTimersByTimeAsync(0);
  expect(admissions.admit).toHaveBeenCalledTimes(1);
  expect(client.commitOffsets).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(500);
  await Promise.all([first, second]);
  expect(
    client.commitOffsets.mock.calls.map(([positions]) => positions[0].offset),
  ).toEqual(['1', '2']);
  controller.abort();
  await running;
});
test.each(['9007199254740991', '9007199254740992', '-1', '01', '1e3', 1])(
  'unsafe current or next offset %j fails before SQL or commit',
  async (offset) => {
    const admissions = { admit: jest.fn() };
    const controller = new AbortController();
    const running = new KafkaSchedulingConsumer(
      { host: 'kafka', port: 9092 },
      admissions,
    ).run(controller.signal);
    const failed = expect(running).rejects.toThrow(
      'Scheduling consumer failed',
    );
    await checkpoint();
    await expect(handler(payload(offset))).rejects.toThrow(
      'Invalid scheduling source',
    );
    await failed;
    expect(admissions.admit).not.toHaveBeenCalled();
    expect(client.commitOffsets).not.toHaveBeenCalled();
  },
);
test('ambiguous broker commit rejection stops queued callbacks without exposing SDK details', async () => {
  client.commitOffsets.mockRejectedValue(
    new Error('fictional-private-sdk-details'),
  );
  const admissions = {
    admit: jest.fn().mockResolvedValue({ disposition: 'duplicate' }),
  };
  const report = jest.fn();
  const controller = new AbortController();
  const running = new KafkaSchedulingConsumer(
    { host: 'kafka', port: 9092 },
    admissions,
    report,
  ).run(controller.signal);
  const failed = expect(running).rejects.toThrow('Scheduling consumer failed');
  await checkpoint();
  const results = await Promise.allSettled([
    handler(payload('0')),
    handler(payload('1')),
  ]);
  await failed;
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(admissions.admit).toHaveBeenCalledTimes(1);
  expect(client.commitOffsets).toHaveBeenCalledTimes(1);
  expect(report.mock.calls.flat()).toEqual([
    'consumer_duplicate',
    'consumer_offset_failed',
  ]);
});
test('a broker commit with no response has a five-second bound and a late reply cannot resume callbacks', async () => {
  let accepted;
  client.commitOffsets.mockImplementation(
    () =>
      new Promise((resolve) => {
        accepted = resolve;
      }),
  );
  const admissions = {
    admit: jest.fn().mockResolvedValue({
      disposition: 'quarantined',
      reason: 'INVALID_ENVELOPE',
    }),
  };
  const controller = new AbortController();
  const running = new KafkaSchedulingConsumer(
    { host: 'kafka', port: 9092 },
    admissions,
  ).run(controller.signal);
  const failed = expect(running).rejects.toThrow('Scheduling consumer failed');
  await checkpoint();
  jest.useFakeTimers();
  const handled = expect(handler(payload('0'))).rejects.toThrow(
    'Scheduling commit unavailable',
  );
  await jest.advanceTimersByTimeAsync(5000);
  await handled;
  await failed;
  accepted();
  await expect(handler(payload('1'))).rejects.toThrow('Scheduling interrupted');
  expect(admissions.admit).toHaveBeenCalledTimes(1);
});
test('shutdown during SQL leaves its commit position unacknowledged', async () => {
  let admitted;
  const admissions = {
    admit: jest.fn(
      () =>
        new Promise((resolve) => {
          admitted = resolve;
        }),
    ),
  };
  const controller = new AbortController();
  const running = new KafkaSchedulingConsumer(
    { host: 'kafka', port: 9092 },
    admissions,
  ).run(controller.signal);
  await checkpoint();
  const delivered = handler(payload());
  const rejected = expect(delivered).rejects.toThrow('Scheduling interrupted');
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  admitted({ disposition: 'scheduled' });
  await rejected;
  await running;
  expect(client.commitOffsets).not.toHaveBeenCalled();
});
test('pre-aborted startup never connects or admits', async () => {
  const admissions = { admit: jest.fn() };
  await new KafkaSchedulingConsumer(
    { host: 'kafka', port: 9092 },
    admissions,
  ).run(AbortSignal.abort());
  expect(client.connect).not.toHaveBeenCalled();
  expect(admissions.admit).not.toHaveBeenCalled();
});
