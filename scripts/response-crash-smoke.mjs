import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const exec = promisify(execFile),
  project = `lab-response-crash-${process.pid}-${Date.now()}`,
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
const fixture = readFileSync(
  new URL('./response-crash-test-actor.mjs', import.meta.url),
  'utf8',
);
const actorName = project + '-response-actor';
try {
  console.log('Starting the response-before-persistence crash checkpoint');
  await compose(['build', 'cli'], 180000);
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '180'],
    240000,
  );
  await compose(['stop', 'executor']);
  const accepted = await cli([
    'ticket',
    'create',
    '--message',
    'crash-private-question-fixture',
    '--key',
    randomUUID(),
  ]);
  const id = accepted.ticket.ticketId;
  await wait(
    async () =>
      (
        await query('SELECT id FROM lab.execution_jobs WHERE ticket_id=$1', [
          id,
        ])
      )[0],
    'Kafka admits the job before the crash actor starts',
  );
  await compose([
    'run',
    '--detach',
    '--name',
    actorName,
    '--no-deps',
    '--entrypoint',
    'node',
    'executor',
    '--input-type=module',
    '-e',
    fixture,
    'hold-response',
  ]);
  const checkpoint = await wait(async () => {
    const r = await docker(['logs', actorName]);
    const rows = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x));
    assert(
      rows.some(
        (x) => x.checkpoint === 'provider-response' && x.attemptNumber === 1,
      ) || !rows.length,
    );
    return rows.find((x) => x.checkpoint === 'response-before-persistence');
  }, 'provider has responded, completion has not begun');
  assert.equal(
    (
      await query(
        'SELECT count(*)::int AS n FROM lab.execution_results WHERE ticket_id=$1',
        [id],
      )
    )[0].n,
    0,
  );
  await docker(['kill', '--signal', 'KILL', actorName]);
  const before = (
    await query(
      'SELECT attempt_id,attempt_count,status FROM lab.execution_jobs WHERE ticket_id=$1',
      [id],
    )
  )[0];
  assert.equal(before.attempt_id, checkpoint.attemptId);
  assert.equal(before.attempt_count, 1);
  assert.equal(before.status, 'running');
  // Observe database time crossing the real lease. No accelerated SQL clock or status edits.
  await wait(
    async () =>
      (
        await query(
          'SELECT lease_expires_at<=clock_timestamp() AS expired FROM lab.execution_jobs WHERE ticket_id=$1',
          [id],
        )
      )[0].expired,
    'the original 30-second lease expires',
  );
  const recovered = await actor('executor', fixture, ['recover']);
  assert(
    recovered.stdout.includes(
      '"checkpoint":"provider-response","attemptNumber":2',
    ),
  );
  assert(recovered.stdout.includes('executor_completed'));
  assert.equal((await cli(['ticket', 'get', id])).ticket.status, 'completed');
  const attempts = await query(
    'SELECT status FROM lab.execution_attempts WHERE job_id=$1 ORDER BY attempt_number',
    [checkpoint.jobId],
  );
  assert.deepEqual(
    attempts.map((x) => x.status),
    ['expired', 'succeeded'],
  );
  const staleCode =
    "import{createRequire}from'node:module';import{readFileSync}from'node:fs';const require=createRequire('/app/apps/worker/package.json');const{Pool}=require('pg');const{ExecutionOwnership}=require('./dist/execution-ownership.js');const p=new Pool({host:'postgres',database:'lab',user:'lab_worker_login',password:readFileSync('/run/lab/worker/password','utf8')});try{console.log(JSON.stringify({saved:await new ExecutionOwnership(p).complete(process.argv[1],process.argv[2],{outcome:'insufficient_evidence',answer:'stale-private-answer-fixture'})}));}finally{await p.end();}";
  assert.deepEqual(
    JSON.parse(
      (
        await actor('executor', staleCode, [
          checkpoint.jobId,
          checkpoint.attemptId,
        ])
      ).stdout,
    ),
    { saved: false },
  );
  assert.equal(
    (
      await query(
        'SELECT count(*)::int AS n FROM lab.execution_results WHERE ticket_id=$1',
        [id],
      )
    )[0].n,
    1,
  );
  console.log(
    JSON.stringify({
      scenario: 'phase3.response-crash',
      status: 'passed',
      checkpointObserved: true,
      providerResponses: 2,
      resultRows: 1,
      realLeaseExpiry: true,
      staleCompletionRejected: true,
    }),
  );
} finally {
  await docker(['rm', '--force', actorName]).catch(() => {});
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
}
