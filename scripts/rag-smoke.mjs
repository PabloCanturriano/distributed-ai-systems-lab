import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile),
  project = `lab-rag-${process.pid}-${Date.now()}`,
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
try {
  console.log(
    'Starting the cited offline RAG journey over authenticated CLI, Kafka and the automatic executor',
  );
  await compose(['build', 'cli'], 180000);
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '180'],
    240000,
  );
  const key = randomUUID();
  const args = [
    'ticket',
    'create',
    '--message',
    'retry policy',
    '--key',
    key,
    '--identity',
    'harbor.requester',
  ];
  const accepted = await cli(args),
    second = await cli([
      'ticket',
      'create',
      '--message',
      'retry policy',
      '--key',
      randomUUID(),
      '--identity',
      'summit.requester',
    ]);
  const harbor = await cli([
    'ticket',
    'wait',
    accepted.ticket.ticketId,
    '--identity',
    'harbor.reader',
    '--deadline',
    '60',
  ]);
  const summit = await cli([
    'ticket',
    'wait',
    second.ticket.ticketId,
    '--identity',
    'summit.reader',
    '--deadline',
    '60',
  ]);
  for (const r of [harbor, summit]) {
    assert.equal(r.ticket.status, 'completed');
    assert.equal(r.ticket.result.outcome, 'answered');
    assert.equal(r.ticket.result.execution.providerMode, 'simulated');
    assert.deepEqual(r.ticket.result.execution.toolCalls, []);
    assert.equal(r.ticket.result.citations.length, 1);
  }
  assert(harbor.ticket.result.answer.includes('HARBOR_PRIVATE_RETRY_V1'));
  assert.equal(harbor.ticket.result.answer.includes('SUMMIT_PRIVATE_'), false);
  assert(summit.ticket.result.answer.includes('SUMMIT_PRIVATE_RETRY_V1'));
  assert.equal(summit.ticket.result.answer.includes('HARBOR_PRIVATE_'), false);
  assert.notEqual(
    harbor.ticket.result.citations[0].documentId,
    summit.ticket.result.citations[0].documentId,
  );
  assert.deepEqual((await cli(args)).ticket, accepted.ticket);
  assert.equal(
    (
      await cli(
        [
          'ticket',
          'get',
          accepted.ticket.ticketId,
          '--identity',
          'summit.reader',
        ],
        2,
      )
    ).error.code,
    'NOT_FOUND',
  );
  const unknown = await cli([
    'ticket',
    'create',
    '--message',
    'orbital telescope aperture',
    '--key',
    randomUUID(),
  ]);
  const abstained = await cli([
    'ticket',
    'wait',
    unknown.ticket.ticketId,
    '--deadline',
    '60',
  ]);
  assert.equal(abstained.ticket.result.outcome, 'insufficient_evidence');
  assert.deepEqual(abstained.ticket.result.citations, []);
  const valid = (
    await query(
      'SELECT count(*)::int AS n FROM lab.result_citations c JOIN lab.execution_evidence e ON e.tenant_id=c.tenant_id AND e.ticket_id=c.ticket_id AND e.generation=c.generation AND e.attempt_id=c.attempt_id AND e.chunk_id=c.chunk_id JOIN lab.execution_configurations x ON x.tenant_id=e.tenant_id AND x.ticket_id=e.ticket_id AND x.generation=e.generation AND x.snapshot_id=e.snapshot_id',
    )
  )[0].n;
  assert.equal(valid, 2);
  const logs = await compose([
    'logs',
    '--no-color',
    'api',
    'relay',
    'consumer',
    'executor',
  ]);
  const text = logs.stdout + logs.stderr;
  for (const sentinel of [
    'HARBOR_PRIVATE_',
    'SUMMIT_PRIVATE_',
    'orbital telescope aperture',
  ])
    assert.equal(text.includes(sentinel), false);
  const records = text.split('\n').flatMap((line) => {
    try {
      const value = JSON.parse(line.slice(line.indexOf('{')));
      return value.event === 'trace_span' ? [value] : [];
    } catch {
      return [];
    }
  });
  const execution = records.find(
      (r) =>
        r.stage === 'execution.run' && r.ticketId === accepted.ticket.ticketId,
    ),
    retrieval = records.find(
      (r) =>
        r.stage === 'retrieval.search' &&
        r.ticketId === accepted.ticket.ticketId,
    );
  assert(execution);
  assert(retrieval);
  assert.equal(retrieval.parentSpanId, execution.spanId);
  assert.equal(retrieval.traceId, accepted.acceptedTraceId);
  const secretCheck =
    "import assert from'node:assert/strict';import{readFileSync}from'node:fs';const text=readFileSync(0,'utf8');for(const c of JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8')).credentials)assert.equal(text.includes(c.secret),false);";
  await actor('seed', secretCheck, [], text + captured.join('\n'));
  console.log(
    JSON.stringify({
      scenario: 'phase4.rag',
      status: 'passed',
      answered: 2,
      abstained: 1,
      immutableCitations: 2,
      tenantIsolation: true,
      retrievalTrace: true,
      providerMode: 'simulated',
    }),
  );
} finally {
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
}
