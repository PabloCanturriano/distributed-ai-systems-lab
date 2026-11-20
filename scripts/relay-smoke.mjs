// Trusted local integration operator. Secrets are read inside their existing jobs only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = `lab-relay-${process.pid}-${Date.now()}`;
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
const docker = (args, timeout = 40000, input) => {
  const pending = exec('docker', args, {
    env,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  pending.child.stdin.end(input);
  return pending;
};
const compose = (args, timeout, input) =>
  docker([...prefix, ...args], timeout, input);
const oneShot = (service, code, args = [], timeout, input) =>
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
    timeout,
    input,
  );
const wait = async (check, label, timeout = 45000) => {
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
async function submit() {
  const code = `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
  const manifest=JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8'));
  const c=manifest.credentials.find(c=>c.alias==='harbor.requester');
  const r=await fetch('http://api:3000/v1/tickets',{method:'POST',headers:{authorization:'Bearer '+c.lookupId+'.'+c.secret,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({message:'relay-private-question-fixture'}),signal:AbortSignal.timeout(5000)});
  assert.equal(r.status,202);const receipt=await r.json();
  const state=await fetch('http://api:3000'+receipt.statusUrl,{headers:{authorization:'Bearer '+c.lookupId+'.'+c.secret},signal:AbortSignal.timeout(5000)});
  assert.equal(state.status,200);assert.equal((await state.json()).status,'queued');console.log(JSON.stringify({ticketId:receipt.ticketId}));`;
  return JSON.parse((await oneShot('seed', code)).stdout).ticketId;
}
async function rows() {
  const code = `import {Client} from 'pg';import {readFileSync} from 'node:fs';
  const c=new Client({host:'postgres',database:'lab',user:'lab_api_login',password:readFileSync('/run/lab/api/password','utf8'),connectionTimeoutMillis:1000,statement_timeout:3000});await c.connect();
  try{await c.query('SET ROLE lab_api');const r=await c.query('SELECT o.event_id,o.ticket_id,o.payload,o.published_at,o.publication_attempts,o.last_error_code,o.claim_token,o.claim_expires_at,e.status FROM lab.outbox_events o JOIN lab.ticket_executions e ON e.ticket_id=o.ticket_id AND e.tenant_id=o.tenant_id AND e.generation=o.generation ORDER BY o.event_id');console.log(JSON.stringify(r.rows));}finally{await c.end();}`;
  return JSON.parse(
    (
      await compose([
        'exec',
        '-T',
        'api',
        'node',
        '--input-type=module',
        '-e',
        code,
      ])
    ).stdout,
  );
}
async function published(ticketId) {
  return wait(
    async () =>
      (await rows()).find((r) => r.ticket_id === ticketId && r.published_at),
    'SQL publication acknowledgement',
  );
}
async function records(count) {
  const r = await compose([
    'exec',
    '-T',
    '--env',
    'KAFKA_HEAP_OPTS=-Xms32m -Xmx128m',
    'kafka',
    '/opt/kafka/bin/kafka-console-consumer.sh',
    '--bootstrap-server',
    'kafka:9092',
    '--topic',
    'tickets.execution-requested.v1',
    '--from-beginning',
    '--max-messages',
    String(count),
    '--timeout-ms',
    '15000',
    '--command-property',
    'enable.auto.commit=false',
    '--formatter-property',
    'print.key=true',
    '--formatter-property',
    'key.separator=|',
  ]);
  return r.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const at = line.indexOf('|');
      return { key: line.slice(0, at), value: line.slice(at + 1) };
    });
}
const driver = `import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
const require=createRequire('/app/apps/worker/package.json');const {Pool}=require('pg');
const {KafkaPublisher}=require('./dist/kafka-publisher.js');const {OutboxPublications}=require('./dist/outbox-publications.js');const {OutboxRelay}=require('./dist/outbox-relay.js');
const pool=new Pool({host:'postgres',database:'lab',user:'lab_relay_login',password:readFileSync('/run/lab/relay/password','utf8'),connectionTimeoutMillis:1000,query_timeout:6000});
pool.on('error',()=>{});const publisher=new KafkaPublisher({host:'kafka',port:9092});
const relay=new OutboxRelay(new OutboxPublications(pool),{publish:async(...args)=>{await publisher.publish(...args);if(process.argv[1]==='crash')process.exit(75);}});
try {const result=await relay.publishBatch(1);assert.equal(result.published,1);const sdk=require('@confluentinc/kafka-javascript');assert.equal(sdk.librdkafkaVersion,'2.16.0');console.log(JSON.stringify({event:'relay_native_delivery_passed',architecture:process.arch,librdkafka:sdk.librdkafkaVersion}));}finally{await publisher.close();await pool.end();}`;

try {
  console.log('Starting isolated HTTP, PostgreSQL and real Kafka relay');
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
    ],
    360000,
  );
  const relay = await inspect('relay');
  assert.equal(relay.Config.User, 'node');
  assert.equal(relay.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(relay.HostConfig.CapDrop, ['ALL']);
  assert.equal(relay.Mounts.length, 1);
  assert.equal(relay.Mounts[0].Destination, '/run/lab/relay');
  assert.equal(relay.Mounts[0].RW, false);
  assert.deepEqual(relay.HostConfig.PortBindings, {});
  const native = JSON.parse(
    (
      await compose([
        'exec',
        '-T',
        'relay',
        'node',
        '-e',
        "console.log(JSON.stringify({architecture:process.arch,librdkafka:require('@confluentinc/kafka-javascript').librdkafkaVersion}))",
      ])
    ).stdout,
  );
  assert.equal(native.librdkafka, '2.16.0');
  console.log(JSON.stringify({ event: 'relay_native_loaded', ...native }));
  await assert.rejects(
    docker([
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      relay.Config.Image,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(
        error.stdout,
        '{"event":"relay_startup_failed"}\n{"event":"relay_stopped"}\n',
      );
      assert.equal(error.stderr, '');
      return true;
    },
  );
  const first = await published(await submit());
  assert.deepEqual(await records(1), [
    { key: first.ticket_id, value: first.payload },
  ]);
  assert.equal(JSON.parse(first.payload).eventId, first.event_id);
  assert.equal(first.status, 'queued');
  console.log(
    'Authenticated HTTP -> exact Kafka key/bytes -> fenced SQL acknowledgement passed',
  );

  await compose(['stop', 'kafka']);
  const secondId = await submit(); // Kafka is deliberately outside API readiness.
  await wait(
    async () =>
      (await rows()).find(
        (r) =>
          r.ticket_id === secondId &&
          !r.published_at &&
          r.last_error_code === 'PUBLISH_FAILED',
      ),
    'broker outage retained retryable work',
  );
  // Stop during a subsequent real send while the broker is unavailable.
  await wait(
    async () =>
      (await rows()).find((r) => r.ticket_id === secondId && r.claim_token),
    'active publication during broker outage',
  );
  const stopping = performance.now();
  await compose(['stop', 'relay']);
  assert.ok(performance.now() - stopping < 15000);
  assert.equal((await inspect('relay')).State.ExitCode, 0);
  await compose(['start', 'relay']);
  await compose(
    ['up', '--detach', '--wait', '--wait-timeout', '120', 'kafka'],
    150000,
  );
  const second = await published(secondId);
  assert.ok(second.publication_attempts >= 2);
  console.log('Broker outage retained pending work and restart delivered it');

  const beforeStop = performance.now();
  await compose(['stop', 'relay']);
  assert.ok(performance.now() - beforeStop < 15000);
  assert.equal((await inspect('relay')).State.ExitCode, 0);
  const thirdId = await submit();
  await assert.rejects(
    oneShot('relay', driver, ['crash']),
    (error) => error.code === 75,
  );
  const crashed = (await rows()).find((r) => r.ticket_id === thirdId);
  assert.equal(crashed.published_at, null);
  assert.ok(crashed.claim_token);
  const beforeRecovery = await records(3);
  assert.equal(
    beforeRecovery.filter((r) => r.value === crashed.payload).length,
    1,
  );
  await compose(['start', 'relay']);
  const third = await published(thirdId); // Exercise the real 30-second lease, no fixture update.
  assert.equal(third.publication_attempts, 2);
  const all = await records(4);
  assert.equal(
    all.filter((r) => r.key === thirdId && r.value === crashed.payload).length,
    2,
  );
  for (const row of [first, second])
    assert.ok(
      all.some((r) => r.key === row.ticket_id && r.value === row.payload),
    );
  console.log(
    'Crash after broker acknowledgement recovered the lease and duplicated the same stable event',
  );
  await compose(['stop', 'relay']);

  if (process.env.RELAY_TEST_PLATFORM) {
    assert.ok(
      ['linux/amd64', 'linux/arm64'].includes(process.env.RELAY_TEST_PLATFORM),
    );
    const image = `${project}-alternate`;
    try {
      await docker(
        [
          'build',
          '--platform',
          process.env.RELAY_TEST_PLATFORM,
          '--target',
          'relay',
          '--tag',
          image,
          '-f',
          'infra/docker/Dockerfile',
          '.',
        ],
        360000,
      );
      const id = await submit();
      const result = await docker(
        [
          'run',
          '--rm',
          '--name',
          `${project}-alternate`,
          '--platform',
          process.env.RELAY_TEST_PLATFORM,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--network',
          `${project}_backend`,
          '--mount',
          `type=volume,src=${project}_relay_secret,dst=/run/lab/relay,readonly`,
          image,
          'node',
          '--input-type=module',
          '-e',
          driver,
        ],
        40000,
      );
      console.log(result.stdout.trim());
      const row = await published(id);
      assert.ok(
        (await records(5)).some((r) => r.key === id && r.value === row.payload),
      );
      console.log(
        `Alternate platform ${process.env.RELAY_TEST_PLATFORM} delivered through the adapter; Docker Desktop may emulate it`,
      );
    } finally {
      await docker(['rm', '--force', `${project}-alternate`]).catch(() => {});
      await docker(['image', 'rm', image]).catch(() => {});
    }
  }
  assert.ok(
    (await rows()).every(
      (r) => r.status === 'queued' && r.published_at && !r.claim_token,
    ),
  );
  const captured = await compose(['logs', '--no-color']);
  const logs = captured.stdout + captured.stderr;
  assert.equal(logs.includes('relay-private-question-fixture'), false);
  assert.equal(logs.includes(first.payload), false);
  // Compare inside trusted jobs so raw credentials never enter host command arguments/output.
  const check = `import assert from 'node:assert/strict';import {readFileSync,existsSync} from 'node:fs';const logs=readFileSync(0,'utf8');for(const role of ['admin','migrator','seed','api','worker','relay']){const path='/run/lab/'+role+'/password';if(existsSync(path))assert.equal(logs.includes(readFileSync(path,'utf8')),false);}const path='/run/lab/demo/identities/identities-v1.json';if(existsSync(path))for(const c of JSON.parse(readFileSync(path,'utf8')).credentials){assert.equal(logs.includes(c.secret),false);}`;
  await oneShot('bootstrap', check, [], undefined, logs);
  await oneShot('seed', check, [], undefined, logs);
  console.log(
    'Relay runtime restrictions, bounded shutdown, queued lifecycle and safe logs passed',
  );
} finally {
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    90000,
  );
}
