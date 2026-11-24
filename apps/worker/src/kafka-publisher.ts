import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { OutboxPublisher } from './outbox-relay';

// Native SDK loading is isolated from the idle worker and the protocol tests.
export class KafkaPublisher implements OutboxPublisher {
  private current:
    | {
        producer: KafkaJS.Producer;
        connected: Promise<void>;
        retiring?: Promise<void>;
      }
    | undefined;
  private closed = false;

  constructor(private readonly endpoint: { host: string; port: number }) {}

  private retire(slot: NonNullable<KafkaPublisher['current']>): Promise<void> {
    slot.retiring ??= slot.producer
      .disconnect()
      .catch(() => {})
      .finally(() => {
        if (this.current === slot) this.current = undefined;
      });
    return slot.retiring;
  }

  async publish(
    message: Parameters<OutboxPublisher['publish']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.closed || signal.aborted || this.current?.retiring)
      throw new Error('Publisher unavailable');
    if (!this.current) {
      const host = this.endpoint.host.includes(':')
        ? `[${this.endpoint.host}]`
        : this.endpoint.host;
      const producer = new KafkaJS.Kafka({
        kafkaJS: {
          brokers: [`${host}:${this.endpoint.port}`],
          connectionTimeout: 2000,
          logLevel: KafkaJS.logLevel.NOTHING,
        },
      }).producer({
        'client.id': 'lab-outbox-relay',
        acks: -1,
        'allow.auto.create.topics': false,
        'delivery.timeout.ms': 5000,
        'request.timeout.ms': 2000,
        'socket.timeout.ms': 2000,
        'socket.connection.setup.timeout.ms': 2000,
        'linger.ms': 0,
        log_level: 0,
        kafkaJS: { retry: { retries: 0 } },
      });
      this.current = { producer, connected: producer.connect() };
    }
    const slot = this.current;
    const abort = () => {
      void this.retire(slot);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await slot.connected;
      if (signal.aborted || this.closed)
        throw new Error('Publisher unavailable');
      await slot.producer.send({
        topic: message.topic,
        messages: [
          {
            key: message.key,
            value: message.value,
            ...(message.traceParent
              ? { headers: { traceparent: message.traceParent } }
              : {}),
          },
        ],
      });
      if (signal.aborted || this.closed)
        throw new Error('Publisher unavailable');
    } catch {
      void this.retire(slot);
      throw new Error('Publication failed');
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.current) await this.retire(this.current);
  }
}
