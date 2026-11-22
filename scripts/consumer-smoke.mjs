import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const project = `lab-consumer-${process.pid}-${Date.now()}`;
const env = { ...process.env, LAB_API_PORT: '0' };
const prefix = [
  'compose',
  '--project-name',
  project,
  '--file',
  'compose.yaml',
  '--profile',
  'messaging',
];
const actor = readFileSync(
  new URL('./consumer-test-actor.mjs', import.meta.url),
  'utf8',
);
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
const wait = async (check, label, timeout = 60000) => {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out: ${label}`);
};
async function inspect(service) {
  const id = (await compose(['ps', '--all', '--quiet', service])).stdout.trim();
  return JSON.parse((await docker(['inspect', id])).stdout)[0];
}
async function query(sql, values = []) {
  const code = `import {Client} from 'pg';import {readFileSync} from 'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));const c=new Client({host:'postgres',database:'lab',user:'lab_migrator_login',password:readFileSync('/run/lab/migrator/password','utf8'),connectionTimeoutMillis:1000,statement_timeout:3000});await c.connect();try{await c.query('BEGIN READ ONLY');await c.query('SET LOCAL ROLE lab_migrator');console.log(JSON.stringify((await c.query(input.sql,input.values)).rows));await c.query('COMMIT');}finally{await c.end();}`;
  return JSON.parse(
    (await oneShot('migrate', code, [], JSON.stringify({ sql, values })))
      .stdout,
  );
}
async function submit() {
  const code = `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';const manifest=JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8'));const c=manifest.credentials.find(x=>x.alias==='harbor.requester');const r=await fetch('http://api:3000/v1/tickets',{method:'POST',headers:{authorization:'Bearer '+c.lookupId+'.'+c.secret,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({message:'consumer-private-question-fixture'}),signal:AbortSignal.timeout(5000)});assert.equal(r.status,202);console.log(JSON.stringify({ticketId:(await r.json()).ticketId}));`;
  return JSON.parse((await oneShot('seed', code)).stdout).ticketId;
}
async function event(ticketId) {
  const [row] = await query(
    'SELECT payload FROM lab.outbox_events WHERE ticket_id=$1',
    [ticketId],
  );
  return { key: ticketId, value: row.payload };
}
async function job(ticketId) {
  return (
    await query(
      'SELECT id,source_event_id FROM lab.execution_jobs WHERE ticket_id=$1',
      [ticketId],
    )
  )[0];
}
const publish = async (message) =>
  JSON.parse(
    (await oneShot('consumer', actor, ['publish'], JSON.stringify(message)))
      .stdout,
  );
async function group(state = false) {
  const result = await compose(
    [
      'exec',
      '-T',
      '--env',
      'KAFKA_HEAP_OPTS=-Xms32m -Xmx128m',
      'kafka',
      '/opt/kafka/bin/kafka-consumer-groups.sh',
      '--bootstrap-server',
      'kafka:9092',
      '--group',
      'lab-ticket-scheduler-v1',
      '--describe',
      ...(state ? ['--state'] : []),
      '--command-config',
      '/dev/stdin',
    ],
    30000,
    'request.timeout.ms=5000\ndefault.api.timeout.ms=10000\n',
  );
  return result.stdout;
}
async function offset(partition = 0) {
  const line = (await group())
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(
      (fields) =>
        fields[0] === 'lab-ticket-scheduler-v1' &&
        fields[1] === 'tickets.execution-requested.v1' &&
        fields[2] === String(partition),
    );
  return line && /^\d+$/.test(line[3]) ? Number(line[3]) : -1;
}
async function committed(report) {
  return wait(
    async () => (await offset(report.partition)) === Number(report.offset) + 1,
    'independent broker offset acknowledgement',
  );
}
async function stopConsumer() {
  const start = performance.now();
  await compose(['stop', 'consumer']);
  assert.ok(performance.now() - start < 15000);
  assert.equal((await inspect('consumer')).State.ExitCode, 0);
}
const extra = `${project}-newcomer`,
  held = `${project}-held`,
  alternate = `${project}-alternate`;
let heldChild,
  heldOutput = '',
  extraOutput = '';
try {
  console.log(
    'Starting real HTTP -> relay -> native consumer -> SQL scheduling',
  );
  await compose(
    [
      'up',
      '--build',
      '--detach',
      '--wait',
      '--wait-timeout',
      '180',
      'api',
      'relay',
      'consumer',
    ],
    360000,
  );
  const initial = await inspect('consumer');
  assert.equal(initial.Config.User, 'node');
  assert.equal(initial.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(initial.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(initial.HostConfig.PortBindings, {});
  assert.equal(initial.Mounts.length, 1);
  assert.equal(initial.Mounts[0].Destination, '/run/lab/worker');
  assert.equal(initial.Mounts[0].RW, false);
  await assert.rejects(
    docker([
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      initial.Config.Image,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(
        error.stdout,
        '{"event":"consumer_failed"}\n{"event":"consumer_stopped"}\n',
      );
      assert.equal(error.stderr, '');
      return true;
    },
  );
  const firstId = await submit();
  const first = await wait(() => job(firstId), 'HTTP-created durable job');
  const firstEvent = await event(firstId);
  const duplicate = await publish(firstEvent);
  await committed(duplicate);
  assert.equal((await job(firstId)).id, first.id);
  const replacement = {
    ...JSON.parse(firstEvent.value),
    eventId: randomUUID(),
  };
  const otherIdentity = await publish({
    ...firstEvent,
    value: JSON.stringify(replacement),
  });
  await committed(otherIdentity);
  assert.equal((await job(firstId)).id, first.id);
  assert.equal(
    (
      await query(
        'SELECT count(*)::int AS n FROM lab.consumer_inbox WHERE ticket_id=$1',
        [firstId],
      )
    )[0].n,
    2,
  );
  console.log(
    'Authenticated HTTP, identical/different event IDs, one job and independent broker commits passed',
  );

  const invalid = 'consumer-private-invalid-fixture';
  const poison = await publish({ key: null, value: invalid });
  await committed(poison);
  assert.deepEqual(
    await query(
      'SELECT "offset",reason,payload_digest FROM lab.event_quarantine',
    ),
    [
      {
        offset: String(poison.offset),
        reason: 'INVALID_ENVELOPE',
        payload_digest: {
          type: 'Buffer',
          data: [...createHash('sha256').update(invalid).digest()],
        },
      },
    ],
  );
  console.log(
    'Invalid event was quarantined before its broker offset advanced',
  );

  // Trusted operator exercises the new ownership protocol on the real
  // consumer-created job; no executor polling loop is enabled by this probe.
  const failJob = `import assert from 'node:assert/strict';import{createRequire}from'node:module';import{readFileSync}from'node:fs';const require=createRequire('/app/apps/worker/package.json');const{Pool}=require('pg');const{ExecutionOwnership}=require('./dist/execution-ownership.js');const pool=new Pool({host:'postgres',database:'lab',user:'lab_worker_login',password:readFileSync('/run/lab/worker/password','utf8'),max:1,connectionTimeoutMillis:1000,query_timeout:6000});pool.on('error',()=>{});try{const owner=new ExecutionOwnership(pool);const claim=await owner.claim();assert.equal(claim.ticketId,process.argv[1]);assert.equal(await owner.fail(claim.jobId,claim.attemptId),true);assert.equal(await owner.fail(claim.jobId,claim.attemptId),false);console.log(JSON.stringify({event:'ownership_failure_committed'}));}finally{await pool.end();}`;
  assert.deepEqual(
    JSON.parse((await oneShot('consumer', failJob, [firstId])).stdout),
    { event: 'ownership_failure_committed' },
  );
  const failure = await wait(
    async () =>
      (
        await query(
          "SELECT payload FROM lab.outbox_events WHERE ticket_id=$1 AND type='ticket.execution.failed' AND published_at IS NOT NULL",
          [firstId],
        )
      )[0],
    'terminal notification relay acknowledgement',
  );
  const failureRecord = await compose([
    'exec',
    '-T',
    '--env',
    'KAFKA_HEAP_OPTS=-Xms32m -Xmx128m',
    'kafka',
    '/opt/kafka/bin/kafka-console-consumer.sh',
    '--bootstrap-server',
    'kafka:9092',
    '--topic',
    'tickets.execution-failed.v1',
    '--from-beginning',
    '--max-messages',
    '1',
    '--timeout-ms',
    '15000',
    '--command-property',
    'enable.auto.commit=false',
    '--formatter-property',
    'print.key=true',
    '--formatter-property',
    'key.separator=|',
  ]);
  assert.equal(failureRecord.stdout.trim(), `${firstId}|${failure.payload}`);
  assert.deepEqual(JSON.parse(failure.payload).data, {
    failureCode: 'EXECUTION_FAILED',
    attemptCount: 1,
  });
  assert.equal(
    (await query('SELECT count(*)::int AS n FROM lab.execution_jobs'))[0].n,
    1,
  );
  console.log(
    'Consumer-created job ownership and atomic failure reached the real failure topic without rescheduling',
  );

  await stopConsumer();
  await compose(['stop', 'relay']);
  const secondId = await submit(),
    thirdId = await submit();
  const secondEvent = await event(secondId),
    thirdEvent = await event(thirdId);
  const earlier = await publish(secondEvent);
  await compose(['stop', 'postgres']);
  await docker(['start', initial.Id]);
  await wait(
    async () =>
      (await compose(['logs', '--no-color', 'consumer'])).stdout.includes(
        'consumer_dependency_unavailable',
      ),
    'consumer attempted SQL during PostgreSQL outage',
  );
  const later = await publish(thirdEvent);
  assert.equal(Number(later.offset), Number(earlier.offset) + 1);
  assert.ok(
    (await offset()) <= Number(earlier.offset),
    'later same-partition record must not bypass failed admission',
  );
  await stopConsumer(); // Disconnect must not auto-commit the pending record either.
  assert.ok((await offset()) <= Number(earlier.offset));
  await compose(
    [
      'up',
      '--detach',
      '--no-deps',
      '--wait',
      '--wait-timeout',
      '90',
      'postgres',
    ],
    120000,
  );
  await docker(['start', initial.Id]);
  await wait(() => job(secondId), 'earlier job after database recovery');
  await wait(() => job(thirdId), 'later job after database recovery');
  await committed(later);
  console.log(
    'PostgreSQL outage blocked later same-partition commits; bounded shutdown and redelivery recovered both jobs',
  );

  await stopConsumer();
  const fourthId = await submit(),
    fourthEvent = await event(fourthId);
  const checkpoint = await publish(fourthEvent);
  const args = [
    'run',
    '--interactive',
    '--name',
    held,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--network',
    `${project}_backend`,
    '--mount',
    `type=volume,src=${project}_worker_secret,dst=/run/lab/worker,readonly`,
    initial.Config.Image,
    'node',
    '--input-type=module',
    '-e',
    actor,
    'hold',
  ];
  heldChild = spawn('docker', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const heldExit = new Promise((resolve, reject) => {
    heldChild.once('error', reject);
    heldChild.once('close', (code) => resolve(code));
  });
  heldChild.stdout.on('data', (chunk) => {
    heldOutput += chunk.toString();
  });
  heldChild.stderr.on('data', (chunk) => {
    heldOutput += chunk.toString();
  });
  await wait(
    () => heldOutput.includes('consumer_sql_checkpoint'),
    'real SQL-before-offset checkpoint',
  );
  const before = await job(fourthId);
  assert.ok(before);
  assert.ok((await offset()) <= Number(checkpoint.offset));
  await docker([
    'run',
    '--detach',
    '--name',
    extra,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--network',
    `${project}_backend`,
    '--mount',
    `type=volume,src=${project}_worker_secret,dst=/run/lab/worker,readonly`,
    initial.Config.Image,
  ]);
  await wait(
    async () =>
      /PreparingRebalance|CompletingRebalance/.test(await group(true)),
    'broker-observed rebalance',
    90000,
  );
  assert.ok((await offset()) <= Number(checkpoint.offset));
  await docker(['kill', '--signal', 'KILL', held]);
  assert.equal(await heldExit, 137);
  await committed(checkpoint);
  assert.deepEqual(await job(fourthId), before);
  assert.equal(
    (
      await query(
        'SELECT count(*)::int AS n FROM lab.consumer_inbox WHERE ticket_id=$1',
        [fourthId],
      )
    )[0].n,
    1,
  );
  const closing = performance.now();
  await docker(['stop', '--time', '15', extra]);
  assert.ok(performance.now() - closing < 15000);
  assert.equal(
    JSON.parse((await docker(['inspect', extra])).stdout)[0].State.ExitCode,
    0,
  );
  extraOutput = (await docker(['logs', extra])).stdout;
  console.log(
    'Crash after SQL commit during rebalance redelivered without replacing the job or skipping its offset',
  );

  if (process.env.CONSUMER_TEST_PLATFORM) {
    assert.ok(
      ['linux/amd64', 'linux/arm64'].includes(
        process.env.CONSUMER_TEST_PLATFORM,
      ),
    );
    const image = `${project}-alternate`;
    try {
      await docker(
        [
          'build',
          '--platform',
          process.env.CONSUMER_TEST_PLATFORM,
          '--target',
          'consumer',
          '--tag',
          image,
          '-f',
          'infra/docker/Dockerfile',
          '.',
        ],
        360000,
      );
      const fifthId = await submit();
      const fifth = await publish(await event(fifthId));
      const result = await docker(
        [
          'run',
          '--rm',
          '--name',
          alternate,
          '--platform',
          process.env.CONSUMER_TEST_PLATFORM,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--network',
          `${project}_backend`,
          '--mount',
          `type=volume,src=${project}_worker_secret,dst=/run/lab/worker,readonly`,
          image,
          'node',
          '--input-type=module',
          '-e',
          actor,
          'once',
        ],
        60000,
      );
      const loaded = result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.event === 'consumer_native_loaded');
      assert.equal(loaded.librdkafka, '2.16.0');
      console.log(JSON.stringify(loaded));
      assert.ok(await job(fifthId));
      await committed(fifth);
      console.log(
        `Alternate ${process.env.CONSUMER_TEST_PLATFORM} consumer admitted and committed; Docker Desktop may emulate it`,
      );
    } finally {
      await docker(['rm', '--force', alternate]).catch(() => {});
      await docker(['image', 'rm', image]).catch(() => {});
    }
  }
  assert.ok(
    (await query('SELECT ticket_id,status FROM lab.ticket_executions')).every(
      (row) => row.status === (row.ticket_id === firstId ? 'failed' : 'queued'),
    ),
  );
  const captured = await compose(['logs', '--no-color']);
  const logs = captured.stdout + captured.stderr + heldOutput + extraOutput;
  for (const value of [
    invalid,
    'consumer-private-question-fixture',
    firstEvent.value,
    fourthEvent.value,
    failure.payload,
  ])
    assert.equal(logs.includes(value), false);
  const check = `import assert from 'node:assert/strict';import{readFileSync,existsSync}from'node:fs';const logs=readFileSync(0,'utf8');for(const role of ['admin','migrator','seed','api','worker','relay']){const p='/run/lab/'+role+'/password';if(existsSync(p))assert.equal(logs.includes(readFileSync(p,'utf8')),false);}const p='/run/lab/demo/identities/identities-v1.json';if(existsSync(p))for(const c of JSON.parse(readFileSync(p,'utf8')).credentials)assert.equal(logs.includes(c.secret),false);`;
  await oneShot('bootstrap', check, [], logs);
  await oneShot('seed', check, [], logs);
  console.log(
    'Consumer isolation, safe logs, expected lifecycle and shutdown passed',
  );
} finally {
  heldChild?.stdin.destroy();
  for (const name of [held, extra, alternate])
    await docker(['rm', '--force', name]).catch(() => {});
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
}
