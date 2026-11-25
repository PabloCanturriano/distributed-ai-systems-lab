import { refreshOperationalMetrics } from './operational-metrics';
import { localTelemetry } from '@lab/telemetry';
import { loadRelayConfiguration } from '@lab/configuration';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomInt } from 'node:crypto';
import { Pool } from 'pg';
import { KafkaPublisher } from './kafka-publisher';
import { OutboxPublications } from './outbox-publications';
import { OutboxRelay } from './outbox-relay';

const controller = new AbortController();
let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
const report = (event: string) => console.log(JSON.stringify({ event }));
function stop() {
  if (controller.signal.aborted) return;
  controller.abort();
  // Covers stalled native teardown or database I/O; pending leases remain recoverable.
  shutdownDeadline = setTimeout(() => {
    report('relay_shutdown_deadline');
    process.exit(1);
  }, 12000);
  shutdownDeadline.unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

async function password(): Promise<string> {
  const file = await open(
    '/run/lab/relay/password',
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size !== 43
    )
      throw new Error('Invalid relay credential');
    const value = await file.readFile('utf8');
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, 'base64url').toString('base64url') !== value
    )
      throw new Error('Invalid relay credential');
    return value;
  } finally {
    await file.close();
  }
}

async function main(): Promise<void> {
  const config = loadRelayConfiguration(process.env);
  const credential = await password();
  if (controller.signal.aborted) return;
  const pool = new Pool({
    ...config.postgres,
    database: 'lab',
    user: 'lab_relay_login',
    password: credential,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 1000,
    query_timeout: 6000,
    statement_timeout: 5000,
    idleTimeoutMillis: 1000,
    application_name: 'lab-outbox-relay',
  });
  pool.on('error', () => report('relay_database_unavailable'));
  const telemetry = localTelemetry('lab-worker', 'relay');
  const publisher = new KafkaPublisher(config.kafka);
  const relay = new OutboxRelay(
    new OutboxPublications(pool),
    publisher,
    telemetry,
  );
  report('relay_started');
  try {
    let nextSnapshot = 0;
    while (!controller.signal.aborted) {
      if (Date.now() >= nextSnapshot) {
        await refreshOperationalMetrics(pool, telemetry).catch(() => {
          telemetry.increment?.('dependency.postgres');
          report('relay_metrics_unavailable');
        });
        nextSnapshot = Date.now() + 5000;
      }
      try {
        // One in-flight send keeps the 30-second lease comfortably above its deadline.
        const result = await relay.publishBatch(1, controller.signal);
        if (result.published) report('relay_publication_acknowledged');
        if (result.retryable) {
          telemetry.increment?.('dependency.kafka');
          report('relay_publication_deferred');
        }
      } catch {
        telemetry.increment?.('dependency.postgres');
        report('relay_batch_unavailable');
      }
      if (!controller.signal.aborted)
        await delay(500 + randomInt(101), undefined, {
          signal: controller.signal,
        }).catch(() => {});
    }
  } finally {
    await Promise.allSettled([
      publisher.close(),
      pool.end(),
      telemetry.shutdown(),
    ]);
  }
}
void main()
  .catch(() => {
    report('relay_startup_failed');
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(shutdownDeadline);
    report('relay_stopped');
  });
