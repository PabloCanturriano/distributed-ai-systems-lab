import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const exec = promisify(execFile);
const project = `lab-client-${process.pid}-${Date.now()}`;
const image = `${project}-probe`;
const container = `${project}-probe`;
const prefix = ['compose', '--project-name', project, '--file', 'compose.yaml'];
const docker = (args, timeout = 40000) =>
  exec('docker', args, { timeout, maxBuffer: 10 * 1024 * 1024 });
const compose = (args, timeout) => docker([...prefix, ...args], timeout);
let child;
let transcript = '';
try {
  console.log('Building the isolated arm64 Kafka client compatibility image');
  await docker(['build', '--tag', image, 'experiments/kafka-client'], 180000);
  await compose(
    ['up', '--detach', '--wait', '--wait-timeout', '120', 'kafka'],
    150000,
  );
  child = spawn(
    'docker',
    [
      'run',
      '--interactive',
      '--name',
      container,
      '--network',
      `${project}_backend`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--memory',
      '512m',
      image,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  child.stderr.on('data', (chunk) => {
    transcript += chunk.toString();
  });
  const deadline = setTimeout(() => {
    child.kill('SIGKILL');
  }, 240000);
  const events = [];
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      transcript += line;
      const event = JSON.parse(line);
      events.push(event.event);
      if (event.event === 'stop_broker') {
        await compose(['stop', 'kafka']);
        child.stdin.write('{"event":"stop_broker_complete"}\n');
      } else if (event.event === 'start_broker') {
        await compose(
          ['up', '--detach', '--wait', '--wait-timeout', '120', 'kafka'],
          150000,
        );
        child.stdin.write('{"event":"start_broker_complete"}\n');
      } else {
        // Probe protocol emits fixed statuses and bounded numeric/version metadata only.
        console.log(JSON.stringify(event));
      }
    }
    assert.equal(await closed, 0, 'client probe must exit successfully');
    assert.ok(events.includes('client_compatibility_passed'));
  } finally {
    clearTimeout(deadline);
  }
  const inspection = JSON.parse(
    (await docker(['inspect', container])).stdout,
  )[0];
  assert.equal(inspection.Config.User, 'node');
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspection.HostConfig.CapDrop, ['ALL']);
  assert.equal(inspection.Mounts.length, 0);
  const brokerLogs = await compose(['logs', '--no-color', 'kafka']);
  const logs = transcript + brokerLogs.stdout + brokerLogs.stderr;
  for (const fixture of [
    'fixture-key',
    'fixture-payload-',
    'fixture-secret-42',
  ])
    assert.equal(
      logs.includes(fixture),
      false,
      'probe/broker logs must not include fixture data',
    );
  console.log('Client runtime restrictions and captured safe logs passed');
} finally {
  child?.stdin.destroy();
  // Clean only this invocation's resources, even when the probe or SDK hangs.
  await docker(['rm', '--force', container]).catch(() => {});
  await compose(['down', '--volumes', '--remove-orphans'], 90000);
  await docker(['image', 'rm', image]).catch(() => {});
}
