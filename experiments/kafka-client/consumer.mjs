// Disposable compatibility actor; never imported by the application.
import sdk from '@confluentinc/kafka-javascript';
import assert from 'node:assert/strict';

const { Kafka, ErrorCodes } = sdk.KafkaJS;
const [group, topic] = process.argv.slice(2);
let current;
let seen = 0;
const emit = (event, fields = {}) => process.send({ event, ...fields });
const consumer = new Kafka().consumer({
  'bootstrap.servers': 'kafka:9092',
  'group.id': group,
  'enable.auto.commit': false,
  'allow.auto.create.topics': false,
  'auto.offset.reset': 'earliest',
  'partition.assignment.strategy': 'range',
  'session.timeout.ms': 6000,
  'heartbeat.interval.ms': 1000,
  'max.poll.interval.ms': 20000,
  'socket.timeout.ms': 3000,
  'socket.connection.setup.timeout.ms': 3000,
  log_level: 0,
  rebalance_cb(error, assignment, functions) {
    if (error.code === ErrorCodes.ERR__ASSIGN_PARTITIONS) {
      functions.assign(assignment);
      emit('assigned', {
        partitions: assignment.map(({ partition }) => partition),
      });
    } else if (error.code === ErrorCodes.ERR__REVOKE_PARTITIONS) {
      emit('revoked', {
        partitions: assignment.map(({ partition }) => partition),
      });
    }
  },
});

process.on('message', async ({ command }) => {
  try {
    if (command === 'release' || command === 'commit') {
      if (!current) throw new Error('No pending handler');
      current.resolve(command);
    } else if (command === 'disconnect') {
      // An unfinished transport checkpoint is released without committing.
      current?.resolve('release');
      await consumer.disconnect();
      emit('disconnected', { seen });
      process.disconnect();
    }
  } catch (error) {
    emit('actor_failed', { code: error.code ?? 'actor' });
    process.exit(1);
  }
});

try {
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  await consumer.run({
    partitionsConsumedConcurrently: 1,
    eachMessage: async ({ topic, partition, message }) => {
      if (current) throw new Error('Handlers overlapped');
      assert.equal(message.key.toString(), 'fixture-key');
      assert.equal(
        message.value.toString(),
        `fixture-payload-${message.offset}`,
      );
      assert.equal(
        message.headers['x-probe-secret'].toString(),
        'fixture-secret-42',
      );
      seen++;
      let resolve;
      const decision = new Promise((done) => {
        resolve = done;
      });
      current = { resolve };
      emit('received', { partition, offset: message.offset, seen });
      const command = await decision;
      if (command === 'commit') {
        const offset = (BigInt(message.offset) + 1n).toString();
        await consumer.commitOffsets([{ topic, partition, offset }]);
        emit('committed', { partition, offset });
      }
      current = undefined;
      emit('handler_released');
    },
  });
  emit('running');
} catch (error) {
  emit('actor_failed', { code: error.code ?? 'actor' });
  process.exit(1);
}
