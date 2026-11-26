import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile),
  project = `lab-cli-${process.pid}-${Date.now()}`;
const env = { ...process.env, LAB_API_PORT: '0' };
const prefix = [
  'compose',
  '--project-name',
  project,
  '--file',
  'compose.yaml',
  '--profile',
  'messaging',
  '--profile',
  'execution',
];
function docker(args, timeout = 40000, input) {
  const pending = exec('docker', args, {
    env,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  pending.child.stdin.end(input);
  return pending;
}
const compose = (args, timeout, input) =>
  docker([...prefix, ...args], timeout, input);
const captured = [];
async function cli(args, exit = 0, reviewerCommand = false) {
  let value;
  try {
    value = await compose(
      reviewerCommand
        ? ['run', '--rm', '-T', 'cli', ...args]
        : ['run', '--rm', '--no-deps', '-T', 'cli', ...args],
      350000,
    );
    assert.equal(exit, 0);
  } catch (error) {
    assert.equal(error.code, exit);
    value = error;
  }
  captured.push(value.stdout, value.stderr);
  const result = JSON.parse(value.stdout);
  assert.equal(result.schemaVersion, 1);
  assert.equal(typeof result.elapsedMs, 'number');
  assert.equal(value.stdout.includes('cli-private-question-fixture'), false);
  // Compose may print lifecycle notices on stderr. CLI progress itself never enters stdout.
  return result;
}
async function inspect(service) {
  const id = (await compose(['ps', '--all', '--quiet', service])).stdout.trim();
  return JSON.parse((await docker(['inspect', id])).stdout)[0];
}
try {
  console.log(
    'Building CLI and starting the complete local workflow from empty volumes',
  );
  await compose(['build', 'cli'], 180000);
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '180'],
    240000,
  );
  const executor = await inspect('executor');
  await compose(['stop', 'executor']);
  const help = await cli(['--help', '--json']);
  assert.equal(help.outcome, 'help');
  const scenarios = await cli(['scenario', 'list', '--json']);
  assert(
    scenarios.scenarios.some(
      (x) => x.name === 'crash-after-response' && x.execution === 'host',
    ),
  );
  assert.equal(
    (await cli(['scenario', 'run', 'crash-after-response', '--json'], 4)).error
      .code,
    'HOST_REQUIRED',
  );
  assert.equal(
    (await cli(['scenario', 'run', 'duplicate-submission', '--json'])).outcome,
    'passed',
  );

  const key = randomUUID();
  const accepted = await cli([
    'ticket',
    'create',
    '--message',
    'cli-private-question-fixture',
    '--key',
    key,
    '--json',
  ]);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.key, key);
  assert.equal(accepted.identity, 'harbor.requester');
  assert.equal(accepted.ticket.generation, 1);
  const ticketId = accepted.ticket.ticketId;
  const duplicate = await cli([
    '--json',
    'ticket',
    'create',
    '--message',
    'cli-private-question-fixture',
    '--key',
    key,
  ]);
  assert.deepEqual(duplicate.ticket, accepted.ticket);
  const conflict = await cli(
    [
      'ticket',
      'create',
      '--message',
      'different fictional question',
      '--key',
      key,
      '--json',
    ],
    2,
  );
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.key, key);
  const queued = await cli([
    'ticket',
    'get',
    ticketId,
    '--identity',
    'harbor.reader',
    '--json',
  ]);
  assert.equal(queued.ticket.status, 'queued');
  assert.equal(queued.outcome, 'observed');
  const timeout = await cli(
    ['ticket', 'wait', ticketId, '--deadline', '1', '--json'],
    5,
  );
  assert.equal(timeout.error.code, 'DEADLINE_EXCEEDED');
  assert.equal(timeout.ticket.status, 'queued');
  const forbidden = await cli(
    [
      'ticket',
      'create',
      '--message',
      'fictional',
      '--identity',
      'harbor.reader',
      '--json',
    ],
    3,
  );
  assert.equal(forbidden.error.code, 'FORBIDDEN');
  const foreign = await cli(
    ['ticket', 'get', ticketId, '--identity', 'summit.reader', '--json'],
    2,
  );
  const absent = await cli(
    ['ticket', 'get', randomUUID(), '--identity', 'summit.reader', '--json'],
    2,
  );
  assert.deepEqual(foreign.error, absent.error);
  assert.equal(foreign.error.code, 'NOT_FOUND');
  assert.equal(
    (await cli(['ticket', 'get', 'invalid', '--json'], 2)).error.code,
    'INVALID_ARGUMENTS',
  );
  await docker(['start', executor.Id]);
  const finished = await cli([
    'ticket',
    'wait',
    ticketId,
    '--deadline',
    '60',
    '--json',
  ]);
  assert.equal(finished.outcome, 'completed');
  assert.equal(finished.ticket.result.execution.providerMode, 'simulated');
  assert.equal(finished.ticket.result.outcome, 'insufficient_evidence');
  assert.deepEqual(finished.ticket.result.citations, []);
  assert.equal(finished.ticket.result.execution.policy, 'bounded-agent-v1');
  assert.equal(finished.ticket.result.execution.toolCalls.length, 3);
  const demo = await cli(
    ['demo', '--identity', 'summit.requester', '--json'],
    0,
    true,
  );
  assert.equal(demo.outcome, 'completed');
  assert.equal(demo.ticket.result.outcome, 'answered');
  assert.equal(demo.ticket.result.citations.length, 1);
  assert.equal(demo.ticket.result.execution.providerMode, 'simulated');
  const human = await cli(['ticket', 'get', ticketId, '--no-color']);
  assert.deepEqual(human.ticket, finished.ticket);
  console.log(
    'CLI create/get/wait/demo, idempotency, terminal simulation, tenant isolation and exit codes passed',
  );
  const probe = await compose([
    'run',
    '--detach',
    '--no-deps',
    '--entrypoint',
    'node',
    'cli',
    '-e',
    'setInterval(()=>{},1000)',
  ]);
  const id = probe.stdout.trim();
  try {
    const details = JSON.parse((await docker(['inspect', id])).stdout)[0];
    assert.equal(details.Config.User, 'node');
    assert.equal(details.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(details.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual(details.HostConfig.PortBindings, {});
    assert.deepEqual(Object.keys(details.NetworkSettings.Networks), [
      `${project}_backend`,
    ]);
    assert.equal(details.Mounts.length, 1);
    assert.equal(details.Mounts[0].Destination, '/run/lab/demo');
    assert.equal(details.Mounts[0].RW, false);
    // No credentials or network are needed for help; a business command without the volume fails closed.
    const missing = await docker([
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      details.Config.Image,
      'ticket',
      'get',
      ticketId,
      '--json',
    ]).then(
      () => assert.fail('Missing credential succeeded'),
      (error) => error,
    );
    assert.equal(missing.code, 3);
    assert.equal(
      JSON.parse(missing.stdout).error.code,
      'CREDENTIAL_UNAVAILABLE',
    );
    captured.push(missing.stdout, missing.stderr);
    const installed = await docker([
      'exec',
      id,
      'node',
      '-e',
      "const fs=require('node:fs');if(fs.existsSync('/app/node_modules/pg')||fs.existsSync('/app/node_modules/@confluentinc/kafka-javascript')||fs.existsSync('/var/run/docker.sock'))process.exit(1)",
    ]);
    assert.equal(installed.stdout, '');
  } finally {
    await docker(['rm', '--force', id]);
  }
  await compose(['stop', 'api']);
  const unavailable = await cli(
    ['ticket', 'get', ticketId, '--deadline', '5', '--json'],
    4,
  );
  assert.equal(unavailable.error.code, 'TRANSPORT_UNAVAILABLE');
  const logs = await compose(['logs', '--no-color']);
  assert.equal(
    (logs.stdout + logs.stderr).includes('cli-private-question-fixture'),
    false,
  );
  // Compare inside the trusted seed container; never return raw credentials to the host.
  const check =
    "import assert from 'node:assert/strict';import{readFileSync}from'node:fs';const text=readFileSync(0,'utf8');for(const c of JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8')).credentials)assert.equal(text.includes(c.secret),false);";
  await compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      'seed',
      '--input-type=module',
      '-e',
      check,
    ],
    40000,
    captured.join('\n') + logs.stdout + logs.stderr,
  );
  console.log(
    'Private read-only CLI mount, no DB/native/socket access, safe JSON/logs, missing credentials and transport failure passed',
  );
} finally {
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
}
