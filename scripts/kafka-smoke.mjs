import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = `lab-kafka-${process.pid}-${Date.now()}`;
const prefix = ['compose', '--project-name', project, '--file', 'compose.yaml'];
const env = { ...process.env, LAB_API_PORT: '0' };
function docker(args, timeout = 40_000, input) {
  const pending = exec('docker', args, {
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  pending.child.stdin.end(input);
  return pending;
}
const compose = (args, timeout, input) =>
  docker([...prefix, ...args], timeout, input);
const cli = (name, args, input) =>
  compose(
    [
      'exec',
      '-T',
      '--env',
      'KAFKA_HEAP_OPTS=-Xms32m -Xmx128m',
      'kafka',
      `/opt/kafka/bin/${name}.sh`,
      ...args,
    ],
    40_000,
    input,
  );
async function inspect(service) {
  const id = (await compose(['ps', '--all', '--quiet', service])).stdout.trim();
  return id ? JSON.parse((await docker(['inspect', id])).stdout)[0] : undefined;
}
async function waitHealthy() {
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    const state = await inspect('kafka');
    if (state?.State.Health?.Status === 'healthy') return;
    assert.equal(
      state?.State.Running,
      true,
      'broker must remain running during startup',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Kafka did not become healthy within the test deadline');
}
const topic = 'lab.transport-probe.v1';
const value = 'transport-probe-value-v1';
async function readProbe() {
  const result = await cli('kafka-console-consumer', [
    '--bootstrap-server',
    'kafka:9092',
    '--topic',
    topic,
    '--partition',
    '0',
    '--offset',
    'earliest',
    '--max-messages',
    '1',
    '--timeout-ms',
    '10000',
    '--command-property',
    'enable.auto.commit=false',
    '--formatter-property',
    'print.key=true',
    '--formatter-property',
    'key.separator=|',
  ]);
  assert.equal(result.stdout.trim(), `transport-key|${value}`);
}
async function assertApiReady() {
  const api = await inspect('api');
  const binding = api.NetworkSettings.Ports['3000/tcp'][0];
  assert.equal(binding.HostIp, '127.0.0.1');
  const response = await fetch(
    `http://127.0.0.1:${binding.HostPort}/health/ready`,
    { signal: AbortSignal.timeout(3000) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready' });
}
try {
  const started = performance.now();
  console.log(
    'Starting isolated Kafka foundation with explicit topic initialization',
  );
  await compose(['config', '--quiet']);
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '180'],
    360_000,
  );
  console.log(
    `Initial Compose build/start completed in ${Math.round(performance.now() - started)} ms`,
  );
  const broker = await inspect('kafka');
  const initializer = await inspect('kafka-init');
  assert.equal(broker.Config.User, 'appuser');
  assert.equal(
    (await cli('kafka-topics', ['--version'])).stdout
      .trim()
      .startsWith('4.4.0'),
    true,
  );
  assert.deepEqual(broker.HostConfig.PortBindings ?? {}, {});
  assert.equal(broker.HostConfig.Privileged, false);
  assert.deepEqual(broker.HostConfig.CapDrop, ['ALL']);
  assert.equal(
    broker.Mounts.some(
      (mount) =>
        mount.Destination === '/var/lib/kafka/data' && mount.Type === 'volume',
    ),
    true,
  );
  assert.equal(initializer.Config.User, 'appuser');
  assert.equal(initializer.State.ExitCode, 0);
  assert.equal(initializer.HostConfig.ReadonlyRootfs, true);
  assert.equal(
    initializer.Mounts.some((mount) =>
      mount.Destination.startsWith('/run/lab'),
    ),
    false,
  );
  const repeat = await compose(
    ['run', '--rm', '--no-deps', '-T', 'kafka-init'],
    150_000,
  );
  assert.equal(
    repeat.stdout.trim(),
    '{"event":"kafka_topics_complete","topics":2}',
  );
  const stats = await docker([
    'stats',
    '--no-stream',
    '--format',
    '{{.MemUsage}} CPU={{.CPUPerc}}',
    broker.Id,
  ]);
  console.log(`Broker resource sample: ${stats.stdout.trim()}`);
  console.log(
    'Pinned broker identity, private network, explicit topics and repeat initialization passed',
  );

  await cli('kafka-topics', [
    '--bootstrap-server',
    'kafka:9092',
    '--create',
    '--topic',
    topic,
    '--partitions',
    '1',
    '--replication-factor',
    '1',
  ]);
  const producer = [
    '--bootstrap-server',
    'kafka:9092',
    '--topic',
    topic,
    '--sync',
    '--command-property',
    'acks=all',
    '--command-property',
    'retries=0',
    '--command-property',
    'max.block.ms=5000',
    '--command-property',
    'request.timeout.ms=3000',
    '--command-property',
    'delivery.timeout.ms=5000',
    '--command-property',
    'linger.ms=0',
    '--reader-property',
    'parse.key=true',
    '--reader-property',
    'key.separator=|',
  ];
  await cli('kafka-console-producer', producer, `transport-key|${value}\n`);
  await readProbe();
  await compose(['stop', 'kafka']);
  await assertApiReady();
  await compose(['start', 'kafka']);
  await waitHealthy();
  await readProbe();
  await assertApiReady();
  console.log(
    'Keyed record survived broker stop/start; API readiness remained independent',
  );

  await cli('kafka-configs', [
    '--bootstrap-server',
    'kafka:9092',
    '--entity-type',
    'topics',
    '--entity-name',
    'tickets.execution-requested.v1',
    '--alter',
    '--add-config',
    'cleanup.policy=[delete,compact]',
  ]);
  let policyRejected = false;
  try {
    await compose(['run', '--rm', '--no-deps', '-T', 'kafka-init'], 150_000);
  } catch (error) {
    policyRejected = true;
    assert.ok(error.stderr.includes('kafka_topics_failed'));
  }
  assert.equal(
    policyRejected,
    true,
    'combined compaction/deletion must not match delete-only policy',
  );
  // Restore only this disposable test's deliberate operator mutation, never from the initializer.
  await cli('kafka-configs', [
    '--bootstrap-server',
    'kafka:9092',
    '--entity-type',
    'topics',
    '--entity-name',
    'tickets.execution-requested.v1',
    '--alter',
    '--add-config',
    'cleanup.policy=delete',
  ]);
  await compose(['run', '--rm', '--no-deps', '-T', 'kafka-init'], 150_000);
  console.log(
    'Initializer rejected combined compaction policy without silently changing it',
  );

  const unknown = producer.map((arg) =>
    arg === topic ? 'lab.unknown-probe.v1' : arg,
  );
  let failed = false;
  try {
    await cli(
      'kafka-console-producer',
      unknown,
      'unknown-key|unknown-probe-value\n',
    );
  } catch {
    failed = true;
  }
  assert.equal(failed, true, 'unknown topic publication must fail');
  const listed = await cli('kafka-topics', [
    '--bootstrap-server',
    'kafka:9092',
    '--list',
  ]);
  assert.equal(listed.stdout.includes('lab.unknown-probe.v1'), false);
  await compose(['down', '--remove-orphans'], 90_000);
  await compose(['up', '--detach', '--wait', '--wait-timeout', '180'], 240_000);
  await readProbe();
  await assertApiReady();
  console.log(
    'Container recreation preserved the record and unknown topics were not auto-created',
  );

  await cli('kafka-topics', [
    '--bootstrap-server',
    'kafka:9092',
    '--alter',
    '--topic',
    'tickets.execution-requested.v1',
    '--partitions',
    '4',
  ]);
  failed = false;
  try {
    await compose(['run', '--rm', '--no-deps', '-T', 'kafka-init'], 150_000);
  } catch (error) {
    failed = true;
    assert.ok(error.stderr.includes('kafka_topics_failed'));
  }
  assert.equal(
    failed,
    true,
    'incompatible partitions must fail initialization',
  );
  await compose(['down', '--remove-orphans'], 90_000);
  failed = false;
  try {
    await compose(
      ['up', '--detach', '--wait', '--wait-timeout', '180'],
      240_000,
    );
  } catch {
    failed = true;
  }
  assert.equal(failed, true, 'incompatible topics must fail worker startup');
  assert.equal((await inspect('worker'))?.State.Running ?? false, false);
  await waitHealthy();
  const description = await cli('kafka-topics', [
    '--bootstrap-server',
    'kafka:9092',
    '--describe',
    '--topic',
    'tickets.execution-requested.v1',
  ]);
  assert.match(description.stdout, /PartitionCount:\s+4\s/);
  await readProbe();
  const logs = await compose(['logs', '--no-color', 'kafka', 'kafka-init']);
  assert.equal(
    (logs.stdout + logs.stderr).includes(value),
    false,
    'default broker/job logs must not include record payloads',
  );
  console.log(
    'Incompatible topic configuration blocked the worker without rewriting topics or losing probe data',
  );
} catch (error) {
  try {
    const logs = await compose([
      'logs',
      '--no-color',
      '--tail',
      '40',
      'kafka',
      'kafka-init',
    ]);
    console.error(logs.stdout + logs.stderr);
  } catch {
    console.error('Kafka diagnostic logs unavailable');
  }
  throw error;
} finally {
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    120_000,
  );
}
