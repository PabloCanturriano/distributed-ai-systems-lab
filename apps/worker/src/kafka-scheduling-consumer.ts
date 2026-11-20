import { KafkaJS } from '@confluentinc/kafka-javascript';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SchedulingAdmissionError,
  type SchedulingAdmissions,
} from './scheduling-admissions';

type ConsumerEvent =
  | 'consumer_admitted'
  | 'consumer_quarantined'
  | 'consumer_duplicate'
  | 'consumer_dependency_unavailable'
  | 'consumer_invalid_source'
  | 'consumer_offset_failed'
  | 'consumer_committed'
  | 'consumer_assigned'
  | 'consumer_revoked';

export class KafkaSchedulingConsumer {
  private readonly client: KafkaJS.Consumer;
  private readonly stopping = new AbortController();
  private readonly done: Promise<void>;
  private finish!: () => void;
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  private disconnecting: Promise<void> | undefined;

  constructor(
    endpoint: { host: string; port: number },
    private readonly admissions: Pick<SchedulingAdmissions, 'admit'>,
    private readonly report: (event: ConsumerEvent) => void = () => {},
    private readonly onClosing: () => void = () => {},
  ) {
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    const host = endpoint.host.includes(':')
      ? `[${endpoint.host}]`
      : endpoint.host;
    this.client = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: [`${host}:${endpoint.port}`],
        connectionTimeout: 2000,
        logLevel: KafkaJS.logLevel.NOTHING,
      },
    }).consumer({
      'client.id': 'lab-scheduling-consumer',
      'enable.auto.commit': false,
      'allow.auto.create.topics': false,
      'auto.offset.reset': 'earliest',
      'partition.assignment.strategy': 'range',
      'session.timeout.ms': 6000,
      'heartbeat.interval.ms': 1000,
      'max.poll.interval.ms': 30000,
      'socket.timeout.ms': 3000,
      'socket.connection.setup.timeout.ms': 2000,
      'queued.min.messages': 1,
      'queued.max.messages.kbytes': 1024,
      'fetch.message.max.bytes': 1048576,
      'fetch.max.bytes': 1048576,
      log_level: 0,
      kafkaJS: {
        groupId: 'lab-ticket-scheduler-v1',
        retry: { retries: 0 },
        fromBeginning: true,
      },
      rebalance_cb: (error: { code: number }) =>
        this.report(
          error.code === KafkaJS.ErrorCodes.ERR__ASSIGN_PARTITIONS
            ? 'consumer_assigned'
            : 'consumer_revoked',
        ),
    });
  }

  private stop(failed = false): void {
    this.failed ||= failed;
    this.stopping.abort();
    this.finish();
  }

  private async handle({
    topic,
    partition,
    message,
  }: KafkaJS.EachMessagePayload): Promise<void> {
    if (this.stopping.signal.aborted) throw new Error('Scheduling interrupted');
    // The pinned native SDK uses Number internally. Validate both this offset and
    // its next commit position before SQL; the SQL port's bigint range is wider.
    const validOffset =
      typeof message.offset === 'string' &&
      /^(0|[1-9][0-9]{0,15})$/.test(message.offset) &&
      BigInt(message.offset) < BigInt(Number.MAX_SAFE_INTEGER);
    if (!validOffset) {
      this.report('consumer_invalid_source');
      this.stop(true);
      throw new Error('Invalid scheduling source');
    }
    const record = {
      topic,
      partition,
      offset: message.offset,
      key: message.key,
      value: message.value,
    };
    for (;;) {
      if (this.stopping.signal.aborted)
        throw new Error('Scheduling interrupted');
      try {
        const result = await this.admissions.admit(record);
        if (this.stopping.signal.aborted)
          throw new Error('Scheduling interrupted');
        this.report(
          result.disposition === 'quarantined'
            ? 'consumer_quarantined'
            : result.disposition === 'scheduled'
              ? 'consumer_admitted'
              : 'consumer_duplicate',
        );
        break;
      } catch (error) {
        if (this.stopping.signal.aborted)
          throw new Error('Scheduling interrupted');
        if (
          error instanceof SchedulingAdmissionError &&
          error.code === 'INVALID_RECORD'
        ) {
          this.report('consumer_invalid_source');
          this.stop(true);
          throw new Error('Invalid scheduling source');
        }
        // Keep this callback pending. A later record must not skip failed SQL.
        this.report('consumer_dependency_unavailable');
        await delay(500, undefined, { signal: this.stopping.signal }).catch(
          () => {},
        );
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.client.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString(),
          },
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Commit deadline')), 5000);
        }),
      ]);
      this.report('consumer_committed');
    } catch {
      // Never move on after ambiguous commit acceptance. Disconnect outside the
      // callback; the durable inbox/job makes a subsequent redelivery safe.
      this.report('consumer_offset_failed');
      this.stop(true);
      throw new Error('Scheduling commit unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  private async start(): Promise<void> {
    await this.client.connect();
    if (this.stopping.signal.aborted) return;
    await this.client.subscribe({ topics: ['tickets.execution-requested.v1'] });
    if (this.stopping.signal.aborted) return;
    await this.client.run({
      partitionsConsumedConcurrently: 1,
      eachMessage: (payload) => {
        // Also serialize at the application boundary, including queued callbacks
        // during assignment changes, rather than relying only on SDK concurrency.
        const task = this.tail.then(() => this.handle(payload));
        this.tail = task.catch(() => {});
        return task;
      },
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    const stop = () => this.stop();
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (signal.aborted) this.stop();
      if (!this.stopping.signal.aborted)
        await Promise.race([this.start(), this.done]);
      await this.done;
      if (this.failed) throw new Error('Scheduling consumer failed');
    } finally {
      signal.removeEventListener('abort', stop);
      this.onClosing();
      await this.close();
    }
  }

  close(): Promise<void> {
    this.stop();
    // SDK stop() is unimplemented. Its disconnect waits for active callbacks;
    // callers must keep the process-level shutdown deadline as a final bound.
    this.disconnecting ??= this.client.disconnect();
    return this.disconnecting;
  }
}
