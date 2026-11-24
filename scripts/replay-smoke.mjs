import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile),
  project = `lab-replay-${process.pid}-${Date.now()}`;
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
  const p = exec('docker', args, { env, timeout, maxBuffer: 20 * 1024 * 1024 });
  p.child.stdin.end(input);
  return p;
}
const compose = (args, timeout, input) =>
  docker([...prefix, ...args], timeout, input);
const captured = [];
async function cli(args, exit = 0) {
  let result;
  try {
    result = await compose(
      ['run', '--rm', '--no-deps', '-T', 'cli', ...args, '--json'],
      90000,
    );
    assert.equal(exit, 0);
  } catch (error) {
    assert.equal(error.code, exit);
    result = error;
  }
  captured.push(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}
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
async function query(sql, values = []) {
  const code =
    "import{Client}from'pg';import{readFileSync}from'node:fs';const x=JSON.parse(readFileSync(0,'utf8'));const c=new Client({host:'postgres',database:'lab',user:'lab_migrator_login',password:readFileSync('/run/lab/migrator/password','utf8'),connectionTimeoutMillis:1000,statement_timeout:3000});await c.connect();try{await c.query('BEGIN READ ONLY');await c.query('SET LOCAL ROLE lab_migrator');console.log(JSON.stringify((await c.query(x.sql,x.values)).rows));await c.query('COMMIT');}finally{await c.end();}";
  return JSON.parse(
    (await actor('migrate', code, [], JSON.stringify({ sql, values }))).stdout,
  );
}
async function inspect(service) {
  const id = (await compose(['ps', '--all', '--quiet', service])).stdout.trim();
  return JSON.parse((await docker(['inspect', id])).stdout)[0];
}
async function wait(check, label) {
  const end = performance.now() + 30000;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  console.log('Starting isolated API/CLI/Kafka replay workflow');
  await compose(['build', 'cli'], 180000);
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '180'],
    240000,
  );
  const executor = await inspect('executor'),
    consumer = await inspect('consumer');
  await compose(['stop', 'executor']);
  const created = await cli([
    'ticket',
    'create',
    '--message',
    'replay-private-question-fixture',
  ]);
  const id = created.ticket.ticketId;
  // Trusted test-only worker actor: observes actual Kafka admission, then uses
  // the existing fenced failure operation. No runtime fault flag or SQL scheduling.
  const fail =
    "import assert from'node:assert/strict';import{Pool}from'pg';import{readFileSync}from'node:fs';import{createRequire}from'node:module';const require=createRequire(import.meta.url),{ExecutionOwnership}=require('/app/apps/worker/dist/execution-ownership.js');const pool=new Pool({host:'postgres',database:'lab',user:'lab_worker_login',password:readFileSync('/run/lab/worker/password','utf8'),connectionTimeoutMillis:1000,statement_timeout:5000});try{const store=new ExecutionOwnership(pool),until=performance.now()+20000;let claim;while(performance.now()<until){claim=await store.claim();if(claim)break;await new Promise(r=>setTimeout(r,300));}assert.equal(claim?.ticketId,process.argv[1]);assert.equal(await store.fail(claim.jobId,claim.attemptId),true);console.log('Fenced test failure recorded after real Kafka admission');}finally{await pool.end();}";
  await actor('executor', fail, [id]);
  const failed = await cli(['ticket', 'wait', id], 1);
  assert.equal(failed.error.code, 'EXECUTION_FAILED');
  assert.equal(failed.ticket.generation, 1);
  await compose(['stop', 'consumer']);
  const key = randomUUID(),
    args = [
      'ticket',
      'replay',
      id,
      '--generation',
      '1',
      '--key',
      key,
      '--identity',
      'harbor.operator',
    ];
  assert.equal(
    (
      await cli(
        ['ticket', 'replay', id, '--generation', '1', '--key', randomUUID()],
        3,
      )
    ).error.code,
    'FORBIDDEN',
  );
  for (const target of [id, randomUUID()])
    assert.equal(
      (
        await cli(
          [
            'ticket',
            'replay',
            target,
            '--generation',
            '1',
            '--key',
            randomUUID(),
            '--identity',
            'summit.operator',
          ],
          2,
        )
      ).error.code,
      'NOT_FOUND',
    );
  const receipt = await cli(args);
  assert.equal(receipt.outcome, 'accepted');
  assert.equal(receipt.ticket.generation, 2);
  await wait(
    async () =>
      (
        await query(
          'SELECT published_at FROM lab.outbox_events WHERE ticket_id=$1 AND generation=2',
          [id],
        )
      )[0]?.published_at,
    'replay publication',
  );
  assert.equal(
    (
      await query(
        'SELECT count(*)::int AS n FROM lab.execution_jobs WHERE generation=2',
      )
    )[0].n,
    0,
  );
  const queued = await cli(['ticket', 'get', id]);
  assert.equal(queued.ticket.generation, 2);
  assert.equal(queued.ticket.status, 'queued');
  assert.equal(queued.ticket.failure, null);
  console.log(
    'Operator replay created one new generation/event/audit; work remained queued with the consumer stopped',
  );
  await docker(['start', consumer.Id, executor.Id]);
  const completed = await cli(['ticket', 'wait', id, '--deadline', '60']);
  assert.equal(completed.ticket.generation, 2);
  assert.equal(completed.ticket.status, 'completed');
  assert.equal(completed.ticket.result.execution.providerMode, 'simulated');
  assert.equal(completed.ticket.result.execution.attemptCount, 1);
  assert.deepEqual((await cli(args)).ticket, receipt.ticket);
  assert.equal(
    (
      await cli(
        [
          'ticket',
          'replay',
          id,
          '--generation',
          '2',
          '--key',
          key,
          '--identity',
          'harbor.operator',
        ],
        2,
      )
    ).error.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (
      await cli(
        [
          'ticket',
          'replay',
          id,
          '--generation',
          '1',
          '--key',
          randomUUID(),
          '--identity',
          'harbor.operator',
        ],
        2,
      )
    ).error.code,
    'REPLAY_CONFLICT',
  );
  const counts = (
    await query(
      "SELECT (SELECT count(*)::int FROM lab.ticket_executions) AS executions,(SELECT count(*)::int FROM lab.execution_jobs) AS jobs,(SELECT count(*)::int FROM lab.execution_attempts) AS attempts,(SELECT count(*)::int FROM lab.execution_results) AS results,(SELECT count(*)::int FROM lab.audit_records) AS audits,(SELECT count(*)::int FROM lab.idempotency_records WHERE operation='tickets:replay:v1') AS receipts",
    )
  )[0];
  assert.deepEqual(counts, {
    executions: 2,
    jobs: 2,
    attempts: 2,
    results: 1,
    audits: 1,
    receipts: 1,
  });
  assert.deepEqual(
    await query(
      'SELECT generation,status FROM lab.ticket_executions ORDER BY generation',
    ),
    [
      { generation: 1, status: 'failed' },
      { generation: 2, status: 'completed' },
    ],
  );
  assert.equal(
    (
      await query(
        'SELECT p.role FROM lab.audit_records a JOIN lab.principals p ON p.id=a.principal_id',
      )
    )[0].role,
    'operator',
  );
  const logs = await compose(['logs', '--no-color']);
  const combined = captured.join('\n') + logs.stdout + logs.stderr;
  assert.equal(combined.includes('replay-private-question-fixture'), false);
  const check =
    "import assert from'node:assert/strict';import{readFileSync}from'node:fs';const text=readFileSync(0,'utf8');for(const c of JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8')).credentials)assert.equal(text.includes(c.secret),false);";
  await actor('seed', check, [], combined);
  console.log(
    'Real replay traversed Kafka and completed generation two; history, tenant/role checks, stable retries, conflicts and safe logs passed',
  );
} finally {
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
}
