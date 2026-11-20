const producers = [];
jest.mock('@confluentinc/kafka-javascript', () => ({
  KafkaJS: {
    logLevel: { NOTHING: 0 },
    Kafka: class {
      producer() {
        const producer = {
          connect: jest.fn().mockResolvedValue(),
          send: jest.fn().mockResolvedValue([]),
          disconnect: jest.fn().mockResolvedValue(),
        };
        producers.push(producer);
        return producer;
      }
    },
  },
}));
const { KafkaPublisher } = require('../apps/worker/dist/kafka-publisher.js');
const message = {
  topic: 'tickets.execution-requested.v1',
  key: 'ticket-id',
  value: '{"eventId":"stable"}',
  eventId: 'stable',
};
beforeEach(() => {
  producers.length = 0;
});
test('publication waits for delivery acknowledgement and preserves exact key and bytes', async () => {
  const publisher = new KafkaPublisher({ host: 'kafka', port: 9092 });
  const first = publisher.publish(message, new AbortController().signal);
  let acknowledge;
  producers[0].send.mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  let completed = false;
  void first.then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(completed).toBe(false);
  expect(producers[0].send).toHaveBeenCalledWith({
    topic: message.topic,
    messages: [{ key: message.key, value: message.value }],
  });
  acknowledge([]);
  await first;
  await publisher.close();
});
test('abort during connection prevents a late connection from sending and allows a fresh producer', async () => {
  const publisher = new KafkaPublisher({ host: 'kafka', port: 9092 });
  const controller = new AbortController();
  const attempt = publisher.publish(message, controller.signal);
  controller.abort();
  await expect(attempt).rejects.toThrow('Publication failed');
  expect(producers[0].send).not.toHaveBeenCalled();
  expect(producers[0].disconnect).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setImmediate(resolve));
  await publisher.publish(message, new AbortController().signal);
  expect(producers).toHaveLength(2);
  await publisher.close();
});
test('an uncertain send retires its producer before another native connection is allowed', async () => {
  const publisher = new KafkaPublisher({ host: 'kafka', port: 9092 });
  const pending = publisher.publish(message, new AbortController().signal);
  let disconnected;
  producers[0].send.mockRejectedValue(
    new Error('fictional-sensitive-broker-detail'),
  );
  producers[0].disconnect.mockImplementation(
    () =>
      new Promise((resolve) => {
        disconnected = resolve;
      }),
  );
  await expect(pending).rejects.toThrow(/^Publication failed$/);
  await expect(
    publisher.publish(message, new AbortController().signal),
  ).rejects.toThrow('Publisher unavailable');
  expect(producers).toHaveLength(1);
  disconnected();
  await new Promise((resolve) => setImmediate(resolve));
  await publisher.publish(message, new AbortController().signal);
  expect(producers).toHaveLength(2);
  await publisher.close();
});
test('aborting an in-flight delivery never reports a late acknowledgement as success', async () => {
  const publisher = new KafkaPublisher({ host: 'kafka', port: 9092 });
  const controller = new AbortController();
  const pending = publisher.publish(message, controller.signal);
  let accepted;
  producers[0].send.mockImplementation(
    () =>
      new Promise((resolve) => {
        accepted = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  accepted([]);
  await expect(pending).rejects.toThrow('Publication failed');
  await publisher.close();
});
test('closed or pre-aborted publishers create no native connection', async () => {
  const publisher = new KafkaPublisher({ host: 'kafka', port: 9092 });
  await expect(publisher.publish(message, AbortSignal.abort())).rejects.toThrow(
    'Publisher unavailable',
  );
  await publisher.close();
  await expect(
    publisher.publish(message, new AbortController().signal),
  ).rejects.toThrow('Publisher unavailable');
  expect(producers).toHaveLength(0);
});
