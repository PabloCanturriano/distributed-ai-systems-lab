import assert from 'node:assert/strict';
import sdk from '@confluentinc/kafka-javascript';
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.versions.node, '24.22.3');
assert.equal(process.versions.modules, '137');
assert.equal(process.getuid(), 1000);
assert.equal(sdk.librdkafkaVersion, '2.16.0');
console.log(
  JSON.stringify({
    event: 'native_load_passed',
    node: process.versions.node,
    abi: process.versions.modules,
    librdkafka: sdk.librdkafkaVersion,
  }),
);

const emit = (event, fields = {}) =>
  console.log(JSON.stringify({ event, ...fields }));
const { Kafka, ConsumerGroupStates } = sdk.KafkaJS;
const base = {
  'bootstrap.servers': 'kafka:9092',
  log_level: 0,
  'socket.timeout.ms': 3000,
  'socket.connection.setup.timeout.ms': 3000,
};
const admin = new Kafka().admin(base);
const producer = new Kafka().producer({
  ...base,
  acks: 'all',
  'allow.auto.create.topics': false,
  'delivery.timeout.ms': 5000,
  'request.timeout.ms': 2000,
  'linger.ms': 0,
});
const actors = new Set();
let stage = 'connect';
const logs = [];
const input = createInterface({ input: process.stdin });
const replies = input[Symbol.asyncIterator]();

class Actor {
  constructor(group, topic) {
    this.events = [];
    this.child = fork(
      new URL('./consumer.mjs', import.meta.url),
      [group, topic],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    actors.add(this);
    this.child.stdout.on('data', (data) => logs.push(data.toString()));
    this.child.stderr.on('data', (data) => logs.push(data.toString()));
    this.child.on('message', (event) => {
      this.events.push(event);
    });
    this.exit = new Promise((resolve) =>
      this.child.once('exit', (code, signal) => {
        this.exited = true;
        resolve({ code, signal });
      }),
    );
  }
  async event(name, predicate = () => true, timeout = 35000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const failure = this.events.find((e) => e.event === 'actor_failed');
      assert.equal(failure, undefined, 'consumer actor failed');
      const index = this.events.findIndex(
        (e) => e.event === name && predicate(e),
      );
      if (index !== -1) return this.events.splice(index, 1)[0];
      assert.equal(this.exited ?? false, false, `actor exited before ${name}`);
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${name}`);
  }
  send(command) {
    this.child.send({ command });
  }
  async close() {
    this.send('disconnect');
    await this.event('disconnected', () => true, 10000);
    const result = await Promise.race([
      this.exit,
      delay(5000).then(() => {
        throw new Error('actor exit deadline');
      }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
    actors.delete(this);
  }
  async kill() {
    this.child.kill('SIGKILL');
    assert.equal((await this.exit).signal, 'SIGKILL');
    actors.delete(this);
  }
}

async function offset(group, topic, partition = 0) {
  const result = await admin.fetchOffsets({
    groupId: group,
    topics: [topic],
    timeout: 5000,
  });
  return (
    result
      .find((entry) => entry.topic === topic)
      ?.partitions.find((entry) => entry.partition === partition)?.offset ??
    '-1'
  );
}
function isUncommitted(value) {
  return BigInt(value) < 0n;
}
async function noCommit(group, topic, duration = 0, partition = 0) {
  const deadline = performance.now() + duration;
  do {
    assert.equal(
      isUncommitted(await offset(group, topic, partition)),
      true,
      'unfinished record must not advance broker offsets',
    );
    if (performance.now() >= deadline) break;
    await delay(100);
  } while (true);
}
async function send(topic, number, partition = 0) {
  const reports = await producer.send({
    topic,
    messages: [
      {
        key: 'fixture-key',
        value: `fixture-payload-${number}`,
        partition,
        headers: { 'x-probe-secret': 'fixture-secret-42' },
      },
    ],
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].partition, partition);
  assert.equal(reports[0].baseOffset, String(number));
}
async function host(event) {
  emit(event);
  const { value, done } = await replies.next();
  assert.equal(done, false);
  assert.equal(JSON.parse(value).event, `${event}_complete`);
}

try {
  await admin.connect();
  await producer.connect();
  await admin.createTopics({
    timeout: 10000,
    topics: [
      'lab.client.manual.v1',
      'lab.client.outage.v1',
      'lab.client.failed.v1',
    ]
      .map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 }))
      .concat([
        {
          topic: 'lab.client.rebalance.v1',
          numPartitions: 2,
          replicationFactor: 1,
        },
      ]),
  });

  stage = 'manual_offsets';
  const topic = 'lab.client.manual.v1';
  const group = 'lab-client-manual';
  await send(topic, 0);
  await send(topic, 1);
  const first = new Actor(group, topic);
  assert.equal((await first.event('received')).offset, '0');
  // A declared observation window longer than the SDK's 5-second default commit interval.
  await noCommit(group, topic, 6500);
  assert.equal(
    first.events.some((e) => e.event === 'received'),
    false,
    'a blocked partition must not dispatch its next record',
  );
  await first.kill();
  await noCommit(group, topic);
  const second = new Actor(group, topic);
  assert.equal((await second.event('received')).offset, '0');
  second.send('commit');
  assert.equal((await second.event('committed')).offset, '1');
  assert.equal((await second.event('received')).offset, '1');
  assert.equal(await offset(group, topic), '1');
  await second.close();
  assert.equal(
    await offset(group, topic),
    '1',
    'normal disconnect must not commit unfinished record',
  );
  const third = new Actor(group, topic);
  assert.equal((await third.event('received')).offset, '1');
  third.send('commit');
  assert.equal((await third.event('committed')).offset, '2');
  await third.close();
  assert.equal(await offset(group, topic), '2');
  emit('manual_offsets_passed');

  stage = 'rebalance';
  const rebalanceTopic = 'lab.client.rebalance.v1';
  const rebalanceGroup = 'lab-client-rebalance';
  const owner = new Actor(rebalanceGroup, rebalanceTopic);
  await owner.event('assigned', (e) => e.partitions.length === 2);
  await send(rebalanceTopic, 0, 1);
  assert.equal((await owner.event('received')).partition, 1);
  const newcomer = new Actor(rebalanceGroup, rebalanceTopic);
  await newcomer.event('running');
  // Broker state confirms that the second member triggered a rebalance while the handler is blocked.
  const deadline = performance.now() + 15000;
  let rebalancing = false;
  while (performance.now() < deadline) {
    const groups = await admin.describeGroups([rebalanceGroup], {
      timeout: 3000,
    });
    if (
      groups.groups.some(
        (entry) => entry.state === ConsumerGroupStates.PREPARING_REBALANCE,
      )
    ) {
      rebalancing = true;
      break;
    }
    await delay(100);
  }
  assert.equal(
    rebalancing,
    true,
    'broker must enter rebalance while the handler is blocked',
  );
  await noCommit(rebalanceGroup, rebalanceTopic, 0, 1);
  owner.send('release');
  await owner.event('handler_released');
  await owner.event('revoked');
  await owner.event('assigned', (e) => e.partitions.length === 1);
  await newcomer.event('assigned', (e) => e.partitions.length === 1);
  // Which member receives partition 1 depends on member ordering; observe actual delivery.
  const deliveryDeadline = performance.now() + 15000;
  let redelivered = false;
  while (performance.now() < deliveryDeadline) {
    if (
      [owner, newcomer].some((actor) =>
        actor.events.some(
          (e) =>
            e.event === 'received' && e.partition === 1 && e.offset === '0',
        ),
      )
    ) {
      redelivered = true;
      break;
    }
    await delay(25);
  }
  assert.equal(
    redelivered,
    true,
    'rebalance must preserve uncommitted delivery',
  );
  await noCommit(rebalanceGroup, rebalanceTopic, 0, 1);
  await newcomer.close();
  await owner.close();
  await noCommit(rebalanceGroup, rebalanceTopic, 0, 1);
  emit('rebalance_passed');

  stage = 'unknown_topic';
  const unknownStarted = performance.now();
  await assert.rejects(
    producer.send({
      topic: 'lab.client.unknown.v1',
      messages: [{ key: 'fixture-key', value: 'fixture-payload-unknown' }],
    }),
  );
  const unknownMs = Math.round(performance.now() - unknownStarted);
  assert.ok(unknownMs < 10000);
  assert.equal(
    (await admin.listTopics({ timeout: 5000 })).includes(
      'lab.client.unknown.v1',
    ),
    false,
  );
  emit('unknown_topic_passed', { durationMs: unknownMs });

  stage = 'outage';
  const recovery = new Actor('lab-client-outage', 'lab.client.outage.v1');
  await recovery.event('assigned');
  await host('stop_broker');
  const stopped = performance.now();
  await assert.rejects(send('lab.client.failed.v1', 0));
  const failureMs = Math.round(performance.now() - stopped);
  assert.ok(failureMs < 10000);
  await host('start_broker');
  const restarted = performance.now();
  await send('lab.client.outage.v1', 0);
  assert.equal((await recovery.event('received')).offset, '0');
  recovery.send('commit');
  await recovery.event('committed');
  await recovery.close();
  emit('outage_recovery_passed', {
    failureMs,
    recoveryMs: Math.round(performance.now() - restarted),
  });
  stage = 'safe_logs';
  const captured = logs.join('');
  for (const secret of ['fixture-key', 'fixture-payload-', 'fixture-secret-42'])
    assert.equal(
      captured.includes(secret),
      false,
      'captured consumer logs must not contain fixture data',
    );
  emit('client_compatibility_passed');
} catch (error) {
  emit('client_compatibility_failed', { stage, code: error.code ?? 'probe' });
  process.exitCode = 1;
} finally {
  for (const actor of actors) actor.child.kill('SIGKILL');
  // Also bound native disconnect/flush: an SDK hang must fail the test, not hide it.
  const cleanupDeadline = setTimeout(() => process.exit(1), 10000);
  await Promise.allSettled([producer.disconnect(), admin.disconnect()]);
  input.close();
  clearTimeout(cleanupDeadline);
}
