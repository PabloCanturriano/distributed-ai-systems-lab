// Trusted integration code injected into disposable containers, never copied to images.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire('/app/apps/worker/package.json');
const sdk = require('@confluentinc/kafka-javascript');
const mode = process.argv[1];
if (mode === 'publish') {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const producer = new sdk.KafkaJS.Kafka().producer({
    'bootstrap.servers': 'kafka:9092',
    acks: -1,
    'allow.auto.create.topics': false,
    'delivery.timeout.ms': 5000,
    'request.timeout.ms': 2000,
    'linger.ms': 0,
    log_level: 0,
  });
  try {
    await producer.connect();
    const reports = await producer.send({
      topic: 'tickets.execution-requested.v1',
      messages: [{ key: input.key, value: input.value, partition: 0 }],
    });
    console.log(
      JSON.stringify({
        partition: reports[0].partition,
        offset: reports[0].baseOffset,
      }),
    );
  } finally {
    await producer.disconnect();
  }
} else {
  assert.equal(sdk.librdkafkaVersion, '2.16.0');
  console.log(
    JSON.stringify({
      event: 'consumer_native_loaded',
      architecture: process.arch,
      librdkafka: sdk.librdkafkaVersion,
    }),
  );
  const { Pool } = require('pg');
  const { SchedulingAdmissions } = require('./dist/scheduling-admissions.js');
  const {
    KafkaSchedulingConsumer,
  } = require('./dist/kafka-scheduling-consumer.js');
  const pool = new Pool({
    host: 'postgres',
    database: 'lab',
    user: 'lab_worker_login',
    password: readFileSync('/run/lab/worker/password', 'utf8'),
    max: 2,
    connectionTimeoutMillis: 1000,
    query_timeout: 6000,
    statement_timeout: 5000,
  });
  pool.on('error', () => {});
  const store = new SchedulingAdmissions(pool);
  const controller = new AbortController();
  let release, deadline;
  const stop = () => {
    controller.abort();
    release?.();
    deadline ??= setTimeout(() => process.exit(1), 12000);
    deadline.unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let checkpoint = false;
  const consumer = new KafkaSchedulingConsumer(
    { host: 'kafka', port: 9092 },
    {
      admit: async (record) => {
        const result = await store.admit(record);
        if (mode === 'hold' && !checkpoint) {
          checkpoint = true;
          console.log(JSON.stringify({ event: 'consumer_sql_checkpoint' }));
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return result;
      },
    },
    (event) => {
      console.log(JSON.stringify({ event }));
      if (mode === 'once' && event === 'consumer_committed') stop();
    },
    stop,
  );
  try {
    await consumer.run(controller.signal);
  } finally {
    stop();
    await Promise.allSettled([consumer.close(), pool.end()]);
    clearTimeout(deadline);
  }
}
