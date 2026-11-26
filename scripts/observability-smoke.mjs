import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile),
  project = `lab-observability-${process.pid}-${Date.now()}`,
  env = {
    ...process.env,
    LAB_API_PORT: '0',
    LAB_JAEGER_PORT: '0',
    LAB_PROMETHEUS_PORT: '0',
    LAB_TELEMETRY_MODE: 'otlp',
  };
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
  '--profile',
  'observability',
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
const dnsFixture = mkdtempSync(join(tmpdir(), 'lab-collector-dns-'));
async function cli(args, exit = 0) {
  let r;
  try {
    r = await compose(
      ['run', '--rm', '--no-deps', '-T', 'cli', ...args, '--json'],
      90000,
    );
    assert.equal(exit, 0);
  } catch (e) {
    if (e.code !== exit) {
      let code = 'UNPARSEABLE_RESPONSE';
      try {
        const value = JSON.parse(e.stdout);
        if (/^[A-Z_]{1,64}$/.test(value.error?.code)) code = value.error.code;
      } catch {}
      console.error(
        JSON.stringify({
          event: 'observability_cli_failed',
          command: args.slice(0, 2).join(' '),
          exit: e.code,
          code,
        }),
      );
    }
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
  // A fresh internal alias prevents prior negative DNS caching from masking
  // shared resolver starvation after the collector stops. Application code and
  // business timeouts are unchanged; only the same collector's test DNS name moves.
  const alias = 'collector-cold-' + randomUUID().replaceAll('-', '');
  const preload = join(dnsFixture, 'preload.cjs');
  writeFileSync(
    preload,
    `
    const dns = require('node:dns');
    const lookup = dns.lookup;
    dns.lookup = function(host, ...args) { if(host === 'collector') console.warn(JSON.stringify({event:'collector_dns_fixture_lookup'})); return lookup.call(dns, host === 'collector' ? '${alias}' : host, ...args); };
    const resolve4 = dns.Resolver.prototype.resolve4;
    dns.Resolver.prototype.resolve4 = function(host, ...args) { if(host === 'collector') console.warn(JSON.stringify({event:'collector_dns_fixture_lookup'})); return resolve4.call(this, host === 'collector' ? '${alias}' : host, ...args); };
  `,
    { mode: 0o444 },
  );
  const services = {
    collector: { networks: { backend: { aliases: [alias] } } },
  };
  for (const service of ['api', 'worker', 'relay', 'consumer', 'executor'])
    services[service] = {
      environment: {
        NODE_OPTIONS: '--require=/run/lab/collector-dns-fixture.cjs',
      },
      volumes: [
        {
          type: 'bind',
          source: preload,
          target: '/run/lab/collector-dns-fixture.cjs',
          read_only: true,
        },
      ],
    };
  const override = join(dnsFixture, 'compose.json');
  writeFileSync(override, JSON.stringify({ services }));
  prefix.push('--file', override);
  console.log(
    'Starting real OTLP, Jaeger and Prometheus acceptance from empty volumes',
  );
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

  async function endpoint(service, port) {
    const value = (
      await compose(['port', service, String(port)])
    ).stdout.trim();
    return 'http://' + value;
  }
  const jaegerURL = await endpoint('jaeger', 16686),
    prometheusURL = await endpoint('prometheus', 9090);
  async function json(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    assert.equal(
      response.ok,
      true,
      'Inspection HTTP status ' + response.status,
    );
    return response.json();
  }
  const remoteTrace = await wait(async () => {
    try {
      const r = await json(jaegerURL + '/api/traces/' + traceId);
      return [
        'http.submit',
        'transaction.submit',
        'outbox.publish',
        'consumer.admit',
        'job.claim',
        'execution.run',
        'result.persist',
      ].every((stage) =>
        r.data?.[0]?.spans?.some((span) => span.operationName === stage),
      )
        ? r.data[0]
        : false;
    } catch {
      return false;
    }
  }, 'Jaeger stores the actual detached trace');
  for (const stage of [
    'http.submit',
    'transaction.submit',
    'outbox.publish',
    'consumer.admit',
    'job.claim',
    'execution.run',
    'result.persist',
  ]) {
    assert(
      remoteTrace.spans.some((s) => s.operationName === stage),
      'Missing remote stage: ' + stage,
    );
  }
  assert.equal(
    JSON.stringify(remoteTrace).includes('private-question-fixture'),
    false,
  );
  async function metric(expression) {
    const value = await json(
      prometheusURL + '/api/v1/query?query=' + encodeURIComponent(expression),
    );
    return value.data.result;
  }
  await wait(async () => {
    try {
      return (await metric('lab_stage_completions_total')).length > 0;
    } catch {
      return false;
    }
  }, 'Prometheus observes real completed stages');
  await wait(
    async () =>
      (await metric('lab_jobs{dimension="completed"}')).some(
        (x) => Number(x.value[1]) >= 3,
      ),
    'durable completed-job snapshot',
  );
  const allSeries = await metric('{__name__=~"lab_.*"}');
  for (const sample of allSeries)
    for (const key of Object.keys(sample.metric))
      assert.equal(
        /ticket|tenant|request|trace|attempt_id|message|answer/.test(key),
        false,
        'Unbounded or sensitive metric label',
      );
  await compose(['stop', 'collector']);
  const outage = await cli([
    'ticket',
    'create',
    '--message',
    'telemetry-outage-private-fixture',
    '--key',
    randomUUID(),
  ]);
  assert.equal(
    (await cli(['ticket', 'wait', outage.ticket.ticketId, '--deadline', '60']))
      .ticket.status,
    'completed',
  );
  await wait(async () => {
    const value = (await compose(['logs', '--no-color', 'relay'])).stdout;
    return value.includes('relay_publication_acknowledged');
  }, 'business progress during collector outage');
  await compose(['start', 'collector']);
  await wait(
    async () =>
      (await metric('lab_telemetry_export_failures_total')).some(
        (x) => Number(x.value[1]) > 0,
      ),
    'export failures remain observable after collector recovery',
  );

  for (const record of [
    root,
    transaction,
    publication,
    admission,
    claim,
    execution,
    persistence,
  ]) {
    const exported = remoteTrace.spans.find(
      (span) => span.spanID === record.spanId,
    );
    assert(exported, 'Jaeger must contain the exact observed SDK span');
    if (record.parentSpanId)
      assert(
        exported.references.some(
          (ref) =>
            ref.spanID === record.parentSpanId && ref.traceID === traceId,
        ),
      );
  }
  const storedOrigins = await query(
    'SELECT DISTINCT substring(trace_parent,4,32) AS trace_id FROM lab.outbox_events WHERE ticket_id=ANY($1::uuid[]) AND trace_parent IS NOT NULL',
    [[id, second.ticketId, third.ticketId]],
  );
  assert.equal(storedOrigins.length, 3);
  const exportedTraces = await Promise.all(
    storedOrigins.map(async (origin) =>
      wait(async () => {
        const value = await json(jaegerURL + '/api/traces/' + origin.trace_id);
        return value.data?.[0]?.spans?.length ? value : false;
      }, 'known persisted trace available for disclosure inspection'),
    ),
  );
  const finalLogs = await compose(['logs', '--no-color']);
  assert(
    (finalLogs.stdout + finalLogs.stderr).includes(
      '"event":"collector_dns_fixture_lookup"',
    ),
    'The cold collector DNS fixture must actually be exercised',
  );
  const disclosureEvidence =
    text +
    finalLogs.stdout +
    finalLogs.stderr +
    JSON.stringify(exportedTraces) +
    JSON.stringify(allSeries);
  for (const sentinel of [
    'trace-private-question-fixture',
    'trace-second-private-fixture',
    'trace-lost-private-fixture',
    'private-trace-fixture',
    'forged-private-tenant',
    'telemetry-outage-private-fixture',
  ])
    assert.equal(disclosureEvidence.includes(sentinel), false);
  const secretCheck =
    "import assert from'node:assert/strict';import{readFileSync}from'node:fs';const text=readFileSync(0,'utf8');for(const c of JSON.parse(readFileSync('/run/lab/demo/identities/identities-v1.json','utf8')).credentials)assert.equal(text.includes(c.secret),false);";
  await actor('seed', secretCheck, [], disclosureEvidence);
  console.log(
    JSON.stringify({
      scenario: 'phase3.observability',
      status: 'passed',
      remoteStages: 7,
      jobSnapshot: true,
      collectorOutageBusinessCompleted: true,
      boundedMetricLabels: true,
    }),
  );
  console.log(
    'Concurrent HTTP idempotency, changed-input conflict, cross-member reads, foreign isolation, invalid trace tolerance, lost-body retry after completion and safe exported spans passed',
  );
  console.log(
    JSON.stringify({
      scenario: 'phase3.trace-correlation',
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
} catch (error) {
  const services = {};
  for (const name of ['api', 'relay', 'consumer', 'executor']) {
    try {
      const c = await inspect(name);
      services[name] = {
        status: c.State.Status,
        exitCode: c.State.ExitCode,
        oomKilled: c.State.OOMKilled,
      };
    } catch {
      services[name] = { status: 'inspection_failed' };
    }
  }
  let jobs = [];
  try {
    jobs = await query(
      'SELECT status,attempt_count,failure_code FROM lab.execution_jobs ORDER BY status',
    );
  } catch {}
  console.error(
    JSON.stringify({ event: 'observability_failure_state', services, jobs }),
  );
  throw error;
} finally {
  try {
    await compose(
      ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
      90000,
    );
  } finally {
    rmSync(dnsFixture, { recursive: true, force: true });
  }
}
