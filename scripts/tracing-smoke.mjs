import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile),
  project = `lab-tracing-${process.pid}-${Date.now()}`,
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
async function spans() {
  const r = await compose([
    'logs',
    '--no-color',
    'api',
    'relay',
    'consumer',
    'executor',
  ]);
  return (r.stdout + r.stderr).split('\n').flatMap((line) => {
    try {
      const x = JSON.parse(line.slice(line.indexOf('{')));
      return x.event === 'trace_span' ? [x] : [];
    } catch {
      return [];
    }
  });
}
try {
  console.log('Starting the phase-2 trace journey from empty volumes');
  await compose(['build', 'cli'], 180000);
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '180'],
    240000,
  );
  const relay = await inspect('relay'),
    consumer = await inspect('consumer'),
    executor = await inspect('executor');
  await compose(['stop', 'relay', 'consumer', 'executor']);
  const key = randomUUID(),
    args = [
      'ticket',
      'create',
      '--message',
      'trace-private-question-fixture',
      '--key',
      key,
    ];
  const accepted = await cli(args),
    id = accepted.ticket.ticketId,
    traceId = accepted.acceptedTraceId;
  assert.match(traceId, /^[a-f0-9]{32}$/);
  const origin = (
    await query(
      'SELECT trace_parent FROM lab.outbox_events WHERE ticket_id=$1',
      [id],
    )
  )[0].trace_parent;
  assert.equal(origin.slice(3, 35), traceId);
  // The original accepting request/process context is gone: each worker resumes
  // only from stored origin metadata, never an in-memory HTTP context.
  await docker(['start', relay.Id]);
  await wait(
    async () =>
      (
        await query(
          'SELECT published_at FROM lab.outbox_events WHERE ticket_id=$1',
          [id],
        )
      )[0].published_at,
    'publication after relay restart',
  );
  assert.equal(
    (await query('SELECT count(*)::int AS n FROM lab.execution_jobs'))[0].n,
    0,
  );
  await docker(['start', consumer.Id]);
  const job = await wait(
    async () =>
      (
        await query(
          'SELECT trace_parent FROM lab.execution_jobs WHERE ticket_id=$1',
          [id],
        )
      )[0],
    'durable admission origin',
  );
  assert.equal(job.trace_parent.slice(3, 35), traceId);
  await wait(
    async () =>
      (await spans()).find(
        (s) =>
          s.traceId === traceId &&
          s.stage === 'consumer.admit' &&
          s.outcome === 'scheduled',
      ),
    'exported admission span',
  );
  await docker(['restart', consumer.Id]);
  assert.equal(
    (
      await query(
        'SELECT trace_parent FROM lab.execution_jobs WHERE ticket_id=$1',
        [id],
      )
    )[0].trace_parent,
    job.trace_parent,
  );
  await docker(['start', executor.Id]);
  const done = await cli(['ticket', 'wait', id, '--deadline', '60']);
  assert.equal(done.ticket.status, 'completed');
  assert.equal(done.ticket.result.execution.providerMode, 'simulated');
  const records = await wait(async () => {
    const values = (await spans()).filter(
      (s) => s.traceId === traceId && s.ticketId === id,
    );
    return [
      'http.submit',
      'transaction.submit',
      'job.claim',
      'outbox.publish',
      'consumer.admit',
      'execution.run',
    ].every((stage) => values.some((s) => s.stage === stage))
      ? values
      : false;
  }, 'the complete exported trace');
  const root = records.find((s) => s.stage === 'http.submit'),
    publication = records.find((s) => s.stage === 'outbox.publish'),
    admission = records.find(
      (s) => s.stage === 'consumer.admit' && s.outcome === 'scheduled',
    ),
    execution = records.find((s) => s.stage === 'execution.run');
  const transaction = records.find((s) => s.stage === 'transaction.submit');
  const claim = records.find((s) => s.stage === 'job.claim');
  const persistence = (await spans()).find(
    (s) => s.traceId === traceId && s.stage === 'result.persist',
  );
  assert.equal(transaction.parentSpanId, root.spanId);
  assert.equal(publication.parentSpanId, transaction.spanId);
  assert.equal(admission.parentSpanId, publication.spanId);
  assert.equal(claim.parentSpanId, admission.spanId);
  assert.equal(execution.parentSpanId, claim.spanId);
  assert.equal(persistence.parentSpanId, execution.spanId);
  assert.equal(execution.outcome, 'completed');
  assert.equal(transaction.spanId, origin.slice(36, 52));
  assert.equal(admission.spanId, job.trace_parent.slice(36, 52));
  assert.deepEqual((await cli(args)).ticket, accepted.ticket);
  assert.equal(
    (
      await query(
        'SELECT trace_parent FROM lab.outbox_events WHERE ticket_id=$1',
        [id],
      )
    )[0].trace_parent,
    origin,
  );
  console.log(
    'One valid trace spans HTTP -> relay -> real Kafka header -> consumer -> detached executor across worker restarts',
  );
  const multiKey = randomUUID();
  const requests =
    "import assert from'node:assert/strict';import{readFileSync}from'node:fs';const m=JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8')),c=m.credentials.find(x=>x.alias==='harbor.operator');async function submit(message,extra={}){return fetch('http://api:3000/v1/tickets',{method:'POST',headers:{authorization:'Bearer '+c.lookupId+'.'+c.secret,'content-type':'application/json','idempotency-key':process.argv[1],traceparent:'private-trace-fixture','x-tenant-id':'forged-private-tenant'},body:JSON.stringify({message,...extra}),signal:AbortSignal.timeout(5000)});}const replies=await Promise.all(Array.from({length:3},()=>submit('trace-second-private-fixture')));const receipts=[];for(const r of replies){assert.equal(r.status,202);assert.match(r.headers.get('traceparent'),/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);receipts.push(await r.json());}assert.deepEqual(receipts[0],receipts[1]);assert.deepEqual(receipts[0],receipts[2]);assert.equal((await submit('different fictional question')).status,409);assert.equal((await submit('trace-second-private-fixture',{tenantId:'forged-private-tenant'})).status,400);console.log(JSON.stringify(receipts[0]));";
  const second = JSON.parse((await actor('seed', requests, [multiKey])).stdout);
  assert.equal(
    (
      await cli([
        'ticket',
        'wait',
        second.ticketId,
        '--identity',
        'harbor.requester',
        '--deadline',
        '60',
      ])
    ).ticket.status,
    'completed',
  );
  for (const foreign of [second.ticketId, randomUUID()])
    assert.equal(
      (await cli(['ticket', 'get', foreign, '--identity', 'summit.reader'], 2))
        .error.code,
      'NOT_FOUND',
    );
  // Deliberately lose the application response body only after real API 202
  // headers prove the write committed; a read-only observer locates its receipt.
  const lostKey = randomUUID();
  const lost =
    "import assert from'node:assert/strict';import{readFileSync}from'node:fs';const c=JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8')).credentials.find(x=>x.alias==='harbor.requester');const r=await fetch('http://api:3000/v1/tickets',{method:'POST',headers:{authorization:'Bearer '+c.lookupId+'.'+c.secret,'content-type':'application/json','idempotency-key':process.argv[1]},body:JSON.stringify({message:'trace-lost-private-fixture'}),signal:AbortSignal.timeout(5000)});assert.equal(r.status,202);await r.body.cancel();console.log('Accepted response body deliberately discarded');";
  await actor('seed', lost, [lostKey]);
  const third = (
    await query(
      "SELECT receipt FROM lab.idempotency_records WHERE operation='tickets:create:v1' AND key=$1",
      [lostKey],
    )
  )[0].receipt;
  assert.equal(
    (await cli(['ticket', 'wait', third.ticketId, '--deadline', '60'])).ticket
      .status,
    'completed',
  );
  assert.deepEqual(
    (
      await cli([
        'ticket',
        'create',
        '--message',
        'trace-lost-private-fixture',
        '--key',
        lostKey,
      ])
    ).ticket,
    third,
  );
  const counts = (
    await query(
      'SELECT (SELECT count(*)::int FROM lab.tickets) AS tickets,(SELECT count(*)::int FROM lab.outbox_events) AS events,(SELECT count(*)::int FROM lab.execution_jobs) AS jobs,(SELECT count(*)::int FROM lab.execution_results) AS results',
    )
  )[0];
  assert.deepEqual(counts, { tickets: 3, events: 3, jobs: 3, results: 3 });
  const logs = await compose(['logs', '--no-color']),
    text = captured.join('\n') + logs.stdout + logs.stderr;
  for (const sentinel of [
    'trace-private-question-fixture',
    'trace-second-private-fixture',
    'trace-lost-private-fixture',
    'private-trace-fixture',
    'forged-private-tenant',
  ])
    assert.equal(text.includes(sentinel), false);
  const secretCheck =
    "import assert from'node:assert/strict';import{readFileSync}from'node:fs';const text=readFileSync(0,'utf8');for(const c of JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8')).credentials)assert.equal(text.includes(c.secret),false);";
  await actor('seed', secretCheck, [], text);
  console.log(
    'Concurrent HTTP idempotency, changed-input conflict, cross-member reads, foreign isolation, invalid trace tolerance, lost-body retry after completion and safe exported spans passed',
  );
  console.log(
    JSON.stringify({
      scenario: 'phase2.trace-correlation',
      status: 'passed',
      traceId,
      stages: [
        'http.submit',
        'outbox.publish',
        'consumer.admit',
        'execution.run',
      ],
    }),
  );
} finally {
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
}
