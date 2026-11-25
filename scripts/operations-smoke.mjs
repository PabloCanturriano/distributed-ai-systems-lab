import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile),
  project = `lab-operations-${process.pid}-${Date.now()}`,
  env = { ...process.env, LAB_API_PORT: '0' };
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
  const p = exec('docker', args, { env, timeout, maxBuffer: 20 * 1024 * 1024 });
  p.child.stdin.end(input);
  return p;
}
const compose = (args, timeout, input) =>
    docker([...prefix, ...args], timeout, input),
  captured = [];
const actor = (service, code, args = [], input) =>
  compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      service,
      '--input-type=module',
      '-e',
      code,
      ...args,
    ],
    40000,
    input,
  );
async function cli(args, exit = 0) {
  let r;
  try {
    r = await compose(
      ['run', '--rm', '--no-deps', '-T', 'cli', ...args, '--json'],
      90000,
    );
    assert.equal(exit, 0);
  } catch (e) {
    assert.equal(e.code, exit);
    r = e;
  }
  captured.push(r.stdout, r.stderr);
  return JSON.parse(r.stdout);
}
async function query(sql, values = []) {
  const code =
    "import{Client}from'pg';import{readFileSync}from'node:fs';const x=JSON.parse(readFileSync(0,'utf8'));const c=new Client({host:'postgres',database:'lab',user:'lab_migrator_login',password:readFileSync('/run/lab/migrator/password','utf8'),connectionTimeoutMillis:1000,statement_timeout:3000});await c.connect();try{await c.query('BEGIN READ ONLY');await c.query('SET LOCAL ROLE lab_migrator');console.log(JSON.stringify((await c.query(x.sql,x.values)).rows));await c.query('COMMIT');}finally{await c.end();}";
  return JSON.parse(
    (await actor('migrate', code, [], JSON.stringify({ sql, values }))).stdout,
  );
}
async function inspect(name) {
  const id = (await compose(['ps', '--all', '--quiet', name])).stdout.trim();
  return JSON.parse((await docker(['inspect', id])).stdout)[0];
}
async function wait(check, label) {
  const end = performance.now() + 45000;
  while (performance.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
const directory = await mkdtemp(join(tmpdir(), 'lab-repair-plan-'));
const publisher = readFileSync(
  new URL('./consumer-test-actor.mjs', import.meta.url),
  'utf8',
);
async function operations(args, exit = 0) {
  let result;
  try {
    result = await exec(process.execPath, ['scripts/operations.mjs', ...args], {
      env,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(exit, 0);
  } catch (error) {
    assert.equal(error.code, exit);
    result = error;
  }
  captured.push(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}
try {
  console.log(
    'Starting separate-role delivery repair with real Kafka in a disposable project',
  );
  const fifo = join(directory, 'invalid-plan-fifo');
  await exec('mkfifo', [fifo]);
  assert.equal(
    (
      await operations(
        [
          'repair',
          '--project',
          project,
          '--plan',
          fifo,
          '--confirm',
          '0'.repeat(64),
        ],
        2,
      )
    ).error.code,
    'INVALID_PLAN',
  );

  await compose(['build', 'cli', 'operations'], 240000);
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '180'],
    240000,
  );
  await compose(['stop', 'relay', 'executor']);
  const secretHashesCode =
    "import{readFileSync}from'node:fs';import{createHash}from'node:crypto';console.log(JSON.stringify(Object.fromEntries(['migrator','seed','api','worker','relay'].map(role=>[role,createHash('sha256').update(readFileSync('/run/lab/'+role+'/password')).digest('hex')]))));";
  const beforeHashes = JSON.parse(
    (await actor('bootstrap', secretHashesCode)).stdout,
  );
  const beforeEnvironment = (
    await query('SELECT id FROM lab.environment_identity')
  )[0].id;
  // Recreate only this disposable fixture's absent new login, retaining all legacy credentials/data.
  const removeNewLogin =
    "import{Client}from'pg';import{readFileSync,renameSync}from'node:fs';const c=new Client({host:'postgres',database:'lab',user:'lab_admin',password:readFileSync('/run/lab/admin/password','utf8')});await c.connect();try{await c.query('REVOKE CONNECT ON DATABASE lab FROM lab_operations_login');await c.query('REVOKE lab_operations FROM lab_operations_login');await c.query('DROP ROLE lab_operations_login');renameSync('/run/lab/operations/password','/run/lab/operations/pre-upgrade-password');}finally{await c.end();}";
  await actor('bootstrap', removeNewLogin);
  await compose(['run', '--rm', '--no-deps', '-T', 'bootstrap']);
  assert.deepEqual(
    JSON.parse((await actor('bootstrap', secretHashesCode)).stdout),
    beforeHashes,
  );
  assert.equal(
    (await query('SELECT id FROM lab.environment_identity'))[0].id,
    beforeEnvironment,
  );
  // An initialized login with missing material must fail closed instead of silently rotating it.
  await actor(
    'bootstrap',
    "import{renameSync}from'node:fs';renameSync('/run/lab/operations/password','/run/lab/operations/missing-password-backup');",
  );
  try {
    await assert.rejects(
      compose(['run', '--rm', '--no-deps', '-T', 'bootstrap']),
    );
    await actor(
      'bootstrap',
      "import assert from'node:assert/strict';import{existsSync}from'node:fs';assert.equal(existsSync('/run/lab/operations/password'),false);",
    );
  } finally {
    await actor(
      'bootstrap',
      "import{renameSync}from'node:fs';renameSync('/run/lab/operations/missing-password-backup','/run/lab/operations/password');",
    );
  }
  await compose(['run', '--rm', '--no-deps', '-T', 'bootstrap']);
  assert.deepEqual(
    JSON.parse((await actor('bootstrap', secretHashesCode)).stdout),
    beforeHashes,
  );

  const accepted = await cli([
    'ticket',
    'create',
    '--message',
    'repair-private-question-fixture',
    '--key',
    randomUUID(),
  ]);
  const id = accepted.ticket.ticketId;
  await actor(
    'consumer',
    publisher,
    ['publish'],
    JSON.stringify({ key: id, value: 'invalid-repair-private-bytes' }),
  );
  await wait(
    async () =>
      (await query('SELECT count(*)::int AS n FROM lab.event_quarantine'))[0]
        .n === 1,
    'real malformed Kafka delivery quarantined',
  );
  const inspection = await operations(['inspect', '--project', project]);
  assert.equal(inspection.queued.length, 1);
  assert.equal(inspection.quarantine.length, 1);
  assert.equal(JSON.stringify(inspection).includes('private'), false);
  const source = inspection.quarantine[0],
    candidate = inspection.queued[0];
  const input = {
    environmentId: inspection.environmentId,
    tenantId: candidate.tenant_id,
    ticketId: id,
    generation: 1,
    expectedEventId: candidate.scheduling_event_id,
    source: {
      partition: source.partition,
      offset: source.offset,
      digest: source.digest,
    },
    reason: 'DELIVERY_RECOVERY',
    key: randomUUID(),
  };
  const inputFile = join(directory, 'input.json'),
    planFile = join(directory, 'plan.json');
  await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
  const plan = await operations([
    'plan',
    '--project',
    project,
    '--input',
    inputFile,
    '--output',
    planFile,
  ]);
  assert.equal(plan.outcome, 'plan_only');
  assert.equal(
    (await query('SELECT count(*)::int AS n FROM lab.delivery_repairs'))[0].n,
    0,
  );
  const apply = [
    'repair',
    '--project',
    project,
    '--plan',
    planFile,
    '--confirm',
    plan.confirmDigest,
  ];
  assert.equal(
    (await operations([...apply.slice(0, -1), '0'.repeat(64)], 2)).error.code,
    'PLAN_CONFLICT',
  );
  assert.equal(
    (
      await operations(
        [
          'repair',
          '--project',
          project + '-wrong',
          '--plan',
          planFile,
          '--confirm',
          plan.confirmDigest,
        ],
        2,
      )
    ).error.code,
    'PLAN_CONFLICT',
  );
  assert.equal(
    (await operations(['inspect', '--project', project + '-wrong'], 3)).error
      .code,
    'PROJECT_CONFLICT',
  );
  // Same Compose project but a plan from a different DB incarnation is rejected.
  const foreignFile = join(directory, 'foreign.json'),
    foreignPlan = join(directory, 'foreign-plan.json');
  await writeFile(
    foreignFile,
    JSON.stringify({ ...input, environmentId: randomUUID() }),
    { mode: 0o600 },
  );
  assert.equal(
    (
      await operations(
        [
          'plan',
          '--project',
          project,
          '--input',
          foreignFile,
          '--output',
          foreignPlan,
        ],
        3,
      )
    ).error.code,
    'ENVIRONMENT_CONFLICT',
  );
  const repaired = await operations(apply);
  assert.equal(repaired.outcome, 'repaired');
  assert.notEqual(repaired.receipt.newEventId, input.expectedEventId);
  assert.deepEqual((await operations(apply)).receipt, repaired.receipt);
  assert.equal(
    (await query('SELECT count(*)::int AS n FROM lab.delivery_repairs'))[0].n,
    1,
  );
  const replacement = (
    await query('SELECT payload FROM lab.outbox_events WHERE event_id=$1', [
      repaired.receipt.newEventId,
    ])
  )[0].payload;
  // Deliver the rebuilt event first, then the old canonical event via the relay.
  await actor(
    'consumer',
    publisher,
    ['publish'],
    JSON.stringify({ key: id, value: replacement }),
  );
  await wait(
    async () =>
      (
        await query(
          'SELECT source_event_id FROM lab.execution_jobs WHERE ticket_id=$1',
          [id],
        )
      )[0],
    'replacement admitted by the actual Kafka consumer',
  );
  await compose(['start', 'relay', 'executor']);
  assert.equal(
    (await cli(['ticket', 'wait', id, '--deadline', '60'])).ticket.status,
    'completed',
  );
  const jobs = await query(
    'SELECT source_event_id FROM lab.execution_jobs WHERE ticket_id=$1',
    [id],
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source_event_id, repaired.receipt.newEventId);
  assert.deepEqual((await operations(apply)).receipt, repaired.receipt);
  const ledger = (
    await query(
      "SELECT actor_database_role,source_digest=decode($1,'hex') AS digest_matches FROM lab.delivery_repairs",
      [source.digest],
    )
  )[0];
  assert.equal(ledger.actor_database_role, 'lab_operations_login');
  assert.equal(ledger.digest_matches, true);
  console.log(
    JSON.stringify({
      scenario: 'phase3.delivery-repair',
      status: 'passed',
      planReadOnly: true,
      confirmationGuards: true,
      environmentFence: true,
      idempotentAfterCompletion: true,
      realKafkaSingleJob: true,
      separateDatabaseActor: true,
      additiveCredentialUpgrade: true,
      missingCredentialFailsClosed: true,
    }),
  );
} finally {
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
  await rm(directory, { recursive: true, force: true });
}
