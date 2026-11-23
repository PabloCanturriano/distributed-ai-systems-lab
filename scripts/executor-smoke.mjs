// The only mutations here are ordinary HTTP submissions and scoped service
// lifecycle operations. Database inspection is read-only; no operator completes jobs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile),
  project = `lab-executor-${process.pid}-${Date.now()}`;
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
const oneShot = (service, code, args = [], input) =>
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
const wait = async (check, label, timeout = 45000) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out: ${label}`);
};
async function inspect(service) {
  const id = (await compose(['ps', '--all', '--quiet', service])).stdout.trim();
  return JSON.parse((await docker(['inspect', id])).stdout)[0];
}
const expectedAnswer =
  'The simulated local provider has no indexed documentation available for this ticket.';
const httpCode = `import assert from 'node:assert/strict';import{readFileSync}from'node:fs';const manifest=JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8'));const mode=process.argv[1],value=process.argv[2],alias=process.argv[3]??'harbor.reader';const c=manifest.credentials.find(x=>x.alias===(mode==='submit'?'harbor.requester':alias));const response=await fetch('http://api:3000/v1/tickets'+(mode==='submit'?'':'/'+value),{method:mode==='submit'?'POST':'GET',headers:{authorization:'Bearer '+c.lookupId+'.'+c.secret,...(mode==='submit'?{'content-type':'application/json','idempotency-key':value}:{})},...(mode==='submit'?{body:JSON.stringify({message:'executor-private-question-fixture'})}:{}),signal:AbortSignal.timeout(5000)});assert.equal(response.headers.get('cache-control'),'no-store');const raw=await response.text();for(const item of manifest.credentials)assert.equal(raw.includes(item.secret),false);assert.equal(response.status,mode==='submit'?202:alias==='summit.reader'?404:200);console.log(JSON.stringify(JSON.parse(raw)));`;
async function submit(key = randomUUID()) {
  return JSON.parse((await oneShot('seed', httpCode, ['submit', key])).stdout);
}
async function read(ticketId, alias = 'harbor.reader') {
  return JSON.parse(
    (await oneShot('seed', httpCode, ['get', ticketId, alias])).stdout,
  );
}
async function completed(ticketId) {
  return wait(async () => {
    const body = await read(ticketId);
    return body.status === 'completed' ? body : false;
  }, 'automatic executor completion');
}
async function query(sql, values = []) {
  const code = `import{Client}from'pg';import{readFileSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));const c=new Client({host:'postgres',database:'lab',user:'lab_migrator_login',password:readFileSync('/run/lab/migrator/password','utf8'),connectionTimeoutMillis:1000,statement_timeout:3000});await c.connect();try{await c.query('BEGIN READ ONLY');await c.query('SET LOCAL ROLE lab_migrator');console.log(JSON.stringify((await c.query(input.sql,input.values)).rows));await c.query('COMMIT');}finally{await c.end();}`;
  return JSON.parse(
    (await oneShot('migrate', code, [], JSON.stringify({ sql, values })))
      .stdout,
  );
}
async function stopExecutor() {
  const start = performance.now();
  await compose(['stop', 'executor']);
  assert.ok(performance.now() - start < 15000);
  assert.equal((await inspect('executor')).State.ExitCode, 0);
}
function assertResult(body) {
  assert.deepEqual(body.result, {
    outcome: 'insufficient_evidence',
    answer: expectedAnswer,
    citations: [],
    execution: { providerMode: 'simulated', attemptCount: 1, toolCalls: [] },
  });
  assert.equal(body.failure, null);
}

try {
  console.log('Starting the complete opt-in stack from empty volumes');
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '180'],
    360000,
  );
  const executor = await inspect('executor');
  const consumer = await inspect('consumer');
  await compose(['stop', 'consumer']);
  assert.equal(executor.Config.User, 'node');
  assert.equal(executor.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(executor.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(executor.HostConfig.PortBindings, {});
  assert.deepEqual(Object.keys(executor.NetworkSettings.Networks), [
    `${project}_backend`,
  ]);
  assert.equal(executor.Mounts.length, 1);
  assert.equal(executor.Mounts[0].Destination, '/run/lab/worker');
  assert.equal(executor.Mounts[0].RW, false);
  await assert.rejects(
    docker([
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      executor.Config.Image,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(
        error.stdout,
        '{"event":"executor_failed"}\n{"event":"executor_stopped"}\n',
      );
      assert.equal(error.stderr, '');
      return true;
    },
  );
  const key = randomUUID(),
    first = await submit(key);
  await wait(
    async () =>
      (
        await query(
          'SELECT published_at FROM lab.outbox_events WHERE ticket_id=$1',
          [first.ticketId],
        )
      )[0]?.published_at,
    'real relay acknowledgement',
  );
  assert.equal(
    (await query('SELECT count(*)::int AS n FROM lab.execution_jobs'))[0].n,
    0,
  );
  assert.equal((await read(first.ticketId)).status, 'queued');
  await docker(['start', consumer.Id]);
  const finished = await completed(first.ticketId);
  assertResult(finished);
  for (const alias of ['harbor.requester', 'harbor.operator'])
    assert.deepEqual(await read(first.ticketId, alias), finished);
  for (const id of [first.ticketId, randomUUID()])
    assert.equal((await read(id, 'summit.reader')).error.code, 'NOT_FOUND');
  const retries = await Promise.all(
    Array.from({ length: 3 }, () => submit(key)),
  );
  for (const receipt of retries) assert.deepEqual(receipt, first);
  assert.deepEqual(await read(first.ticketId), finished);
  console.log(
    'Authenticated HTTP -> real Kafka -> consumer -> automatic executor -> persisted simulated HTTP result passed',
  );
  await stopExecutor();
  const second = await submit();
  await wait(
    async () =>
      (
        await query('SELECT id FROM lab.execution_jobs WHERE ticket_id=$1', [
          second.ticketId,
        ])
      )[0],
    'durable job while executor stopped',
  );
  assert.equal((await read(second.ticketId)).status, 'queued');
  await docker(['start', executor.Id]);
  assertResult(await completed(second.ticketId));
  console.log(
    'A stopped executor retained queued work and resumed it without operator completion',
  );
  await stopExecutor();
  const third = await submit();
  await wait(
    async () =>
      (
        await query('SELECT id FROM lab.execution_jobs WHERE ticket_id=$1', [
          third.ticketId,
        ])
      )[0],
    'admission before broker outage',
  );
  await compose(['stop', 'kafka']);
  await docker(['start', executor.Id]);
  assertResult(await completed(third.ticketId));
  console.log(
    'An admitted job completed with Kafka offline; PostgreSQL owns post-delivery execution',
  );
  const counts = await query(
    'SELECT (SELECT count(*)::int FROM lab.tickets) AS tickets,(SELECT count(*)::int FROM lab.consumer_inbox) AS inbox,(SELECT count(*)::int FROM lab.execution_jobs) AS jobs,(SELECT count(*)::int FROM lab.execution_attempts) AS attempts,(SELECT count(*)::int FROM lab.execution_results) AS results',
  );
  assert.deepEqual(counts, [
    { tickets: 3, inbox: 3, jobs: 3, attempts: 3, results: 3 },
  ]);
  assert.ok(
    (
      await query(
        'SELECT status,attempt_id,lease_expires_at FROM lab.execution_jobs',
      )
    ).every(
      (row) =>
        row.status === 'completed' &&
        row.attempt_id === null &&
        row.lease_expires_at === null,
    ),
  );
  await stopExecutor();
  await compose(
    ['up', '--detach', '--no-deps', '--wait', '--wait-timeout', '120', 'kafka'],
    150000,
  );
  const captured = await compose(['logs', '--no-color']);
  const logs = captured.stdout + captured.stderr;
  for (const value of [expectedAnswer, 'executor-private-question-fixture'])
    assert.equal(logs.includes(value), false);
  const check = `import assert from 'node:assert/strict';import{readFileSync,existsSync}from'node:fs';const logs=readFileSync(0,'utf8');for(const role of ['admin','migrator','seed','api','worker','relay']){const p='/run/lab/'+role+'/password';if(existsSync(p))assert.equal(logs.includes(readFileSync(p,'utf8')),false);}const p='/run/lab/demo/identities/identities-v1.json';if(existsSync(p))for(const c of JSON.parse(readFileSync(p,'utf8')).credentials)assert.equal(logs.includes(c.secret),false);`;
  await oneShot('bootstrap', check, [], logs);
  await oneShot('seed', check, [], logs);
  console.log(
    'Idempotent receipts, tenant isolation, real durable counts, private mounts, safe logs and bounded shutdown passed',
  );
} finally {
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
}
