import { loadConsumerConfiguration } from '@lab/configuration';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Pool } from 'pg';
import { KafkaSchedulingConsumer } from './kafka-scheduling-consumer';
import { SchedulingAdmissions } from './scheduling-admissions';

const controller = new AbortController();
const report = (event: string) => console.log(JSON.stringify({ event }));
let deadline: ReturnType<typeof setTimeout> | undefined;
function stop(): void {
  if (controller.signal.aborted) return;
  controller.abort();
  deadline = setTimeout(() => {
    report('consumer_shutdown_deadline');
    process.exit(1);
  }, 12000);
  deadline.unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

async function password(): Promise<string> {
  const file = await open(
    '/run/lab/worker/password',
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
      throw new Error('Invalid worker credential');
    const value = await file.readFile('utf8');
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, 'base64url').toString('base64url') !== value
    )
      throw new Error('Invalid worker credential');
    return value;
  } finally {
    await file.close();
  }
}

async function main(): Promise<void> {
  const config = loadConsumerConfiguration(process.env);
  const credential = await password();
  if (controller.signal.aborted) return;
  const pool = new Pool({
    ...config.postgres,
    database: 'lab',
    user: 'lab_worker_login',
    password: credential,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 1000,
    query_timeout: 6000,
    statement_timeout: 5000,
    idleTimeoutMillis: 1000,
    application_name: 'lab-scheduling-consumer',
  });
  pool.on('error', () => report('consumer_database_unavailable'));
  let consumer: KafkaSchedulingConsumer | undefined;
  try {
    consumer = new KafkaSchedulingConsumer(
      config.kafka,
      new SchedulingAdmissions(pool),
      report,
      stop,
    );
    report('consumer_started');
    await consumer.run(controller.signal);
  } finally {
    // Fatal startup/commit errors need the same hard teardown bound as signals.
    stop();
    await Promise.allSettled([consumer?.close(), pool.end()]);
  }
}
void main()
  .catch(() => {
    report('consumer_failed');
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(deadline);
    report('consumer_stopped');
  });
