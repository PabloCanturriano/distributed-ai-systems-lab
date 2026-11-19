import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const project = `lab-compose-${process.pid}-${Date.now()}`;
const env = { ...process.env, LAB_API_PORT: '0' };
const prefix = ['compose', '--project-name', project, '--file', 'compose.yaml'];
const docker = (args, timeout = 30_000) =>
  exec('docker', args, { env, timeout, maxBuffer: 20 * 1024 * 1024 });
const compose = (args, timeout) => docker([...prefix, ...args], timeout);
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function report() {
  const script = `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const roles = ['admin','migrator','seed','api','worker','relay'];
    const raw = fs.readFileSync('/run/lab/demo/identities/identities-v1.json');
    const manifest = JSON.parse(raw);
    console.log(JSON.stringify({
      passwords: roles.map(role => hash(fs.readFileSync('/run/lab/' + role + '/password'))),
      secrets: manifest.credentials.map(c => hash(c.secret)),
      manifest: hash(raw),
      uid: fs.statSync('/run/lab/demo/identities/identities-v1.json').uid,
      mode: fs.statSync('/run/lab/demo/identities/identities-v1.json').mode & 511,
    }));
  `;
  return JSON.parse(
    (
      await compose([
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'node',
        'secrets',
        '-e',
        script,
      ])
    ).stdout,
  );
}

async function identityCounts() {
  const script = `
    import { Client } from 'pg';
    import { readFileSync } from 'node:fs';
    const client = new Client({host:'postgres',database:'lab',user:'lab_seed_login',password:readFileSync('/run/lab/seed/password','utf8'),connectionTimeoutMillis:5000,statement_timeout:5000});
    await client.connect();
    try {
      await client.query('SET ROLE lab_seed');
      const result = await client.query('SELECT (SELECT count(*)::int FROM lab.tenants) AS tenants,(SELECT count(*)::int FROM lab.principals) AS principals,(SELECT count(*)::int FROM lab.auth_credentials) AS credentials,(SELECT count(*)::int FROM lab.seed_manifests) AS manifests');
      console.log(JSON.stringify(result.rows[0]));
    } finally { await client.end(); }
  `;
  return JSON.parse(
    (
      await compose([
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'node',
        'seed',
        '--input-type=module',
        '-e',
        script,
      ])
    ).stdout,
  );
}

async function isRunning(service) {
  const id = (await compose(['ps', '--all', '--quiet', service])).stdout.trim();
  return id
    ? (
        await docker(['inspect', '--format', '{{.State.Running}}', id])
      ).stdout.trim() === 'true'
    : false;
}

async function inspectService(service) {
  const id = (await compose(['ps', '--all', '--quiet', service])).stdout.trim();
  return JSON.parse((await docker(['inspect', id])).stdout)[0];
}

try {
  console.log('Building and starting isolated Compose foundation');
  await compose(['config', '--quiet']);
  await compose(
    ['up', '--build', '--detach', '--wait', '--wait-timeout', '120'],
    300_000,
  );
  const before = await report();
  assert.equal(before.uid, 1000);
  assert.equal(before.mode, 0o600);
  assert.equal(new Set(before.passwords).size, 6);
  assert.equal(new Set(before.secrets).size, 6);
  assert.deepEqual(await identityCounts(), {
    tenants: 2,
    principals: 6,
    credentials: 6,
    manifests: 1,
  });
  const api = await inspectService('api');
  const postgres = await inspectService('postgres');
  assert.deepEqual(postgres.HostConfig.PortBindings ?? {}, {});
  assert.equal(api.Mounts.length, 1);
  assert.equal(api.Mounts[0].Destination, '/run/lab/api');
  assert.equal(api.Mounts[0].RW, false);
  const redis = await inspectService('redis');
  assert.deepEqual(redis.HostConfig.PortBindings ?? {}, {});
  assert.equal(redis.Config.User, 'redis');
  assert.equal(api.Config.User, 'node');
  const bindings = api.NetworkSettings.Ports['3000/tcp'];
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, '127.0.0.1');
  const url = `http://127.0.0.1:${bindings[0].HostPort}`;
  assert.equal(
    (await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(2000) }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(3000) }))
      .status,
    200,
  );
  assert.deepEqual((await inspectService('worker')).Mounts, []);
  for (const service of ['secrets', 'bootstrap', 'migrate', 'seed']) {
    const state = await inspectService(service);
    assert.equal(state.State.ExitCode, 0);
    assert.equal(state.HostConfig.Privileged, false);
    assert.equal(state.HostConfig.ReadonlyRootfs, true);
  }
  const bootstrap = await inspectService('bootstrap');
  assert.equal(bootstrap.Mounts.length, 6);
  assert.ok(bootstrap.Mounts.every((mount) => !mount.RW));
  assert.equal((await inspectService('migrate')).Mounts.length, 1);
  assert.equal((await inspectService('seed')).Mounts.length, 2);
  console.log(
    'Initialization, scoped mounts, loopback publication, and safe health passed',
  );

  function assertNoGeneratedSecrets(logs) {
    const known = new Set([...before.passwords, ...before.secrets]);
    for (const match of logs.matchAll(/(?=([A-Za-z0-9_-]{43}))/g)) {
      assert.equal(
        known.has(hash(match[1])),
        false,
        'a generated secret appeared in Compose logs',
      );
    }
  }
  async function expectReadiness(status) {
    const deadline = performance.now() + 20000;
    let response;
    while (performance.now() < deadline) {
      response = await fetch(`${url}/health/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.status === status) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {
      status: status === 200 ? 'ready' : 'not_ready',
    });
    assert.equal(
      (await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(2000) }))
        .status,
      200,
    );
  }
  for (const service of ['redis', 'postgres']) {
    await compose(['stop', service]);
    await expectReadiness(503);
    await compose(['start', service]);
    await expectReadiness(200);
    const current = await inspectService('api');
    assert.equal(current.Id, api.Id);
    assert.equal(current.RestartCount, 0);
  }
  console.log(
    'Readiness degraded and recovered after Redis/PostgreSQL outages without an API restart',
  );

  for (const service of ['redis', 'postgres']) {
    console.log(`Checking unresponsive ${service}`);
    await compose(['pause', service]);
    try {
      await expectReadiness(503);
    } finally {
      await compose(['unpause', service]);
    }
    await expectReadiness(200);
  }
  assert.equal((await inspectService('api')).Id, api.Id);
  assert.equal((await inspectService('api')).RestartCount, 0);
  console.log('Unresponsive dependencies timed out safely and recovered');
  const runtimeLogs = await compose(['logs', '--no-color']);
  assertNoGeneratedSecrets(runtimeLogs.stdout + runtimeLogs.stderr);
  await compose(['stop', 'redis']);
  await expectReadiness(503);
  await compose(['stop', 'api']);
  const stopped = await inspectService('api');
  assert.ok(
    [0, 143].includes(stopped.State.ExitCode),
    'configured API shutdown must finish without SIGKILL',
  );
  console.log('API shut down cleanly while Redis reconnection was pending');

  await compose(['up', '--detach', '--wait', '--wait-timeout', '120'], 180_000);
  assert.deepEqual(await report(), before);
  await compose(['down', '--remove-orphans']);
  await compose(['up', '--detach', '--wait', '--wait-timeout', '120'], 180_000);
  assert.deepEqual(await report(), before);
  assert.deepEqual(await identityCounts(), {
    tenants: 2,
    principals: 6,
    credentials: 6,
    manifests: 1,
  });
  const repeat = await compose(['run', '--rm', '--no-deps', '-T', 'seed']);
  assert.ok(repeat.stdout.includes('"status":"unchanged"'));
  console.log(
    'Repeated startup and container recreation preserved all credentials and rows',
  );

  await compose(['down', '--remove-orphans']);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    'node',
    'secrets',
    '-e',
    "require('node:fs').unlinkSync('/run/lab/demo/identities/identities-v1.json')",
  ]);
  let rejected = false;
  try {
    await compose(
      ['up', '--detach', '--wait', '--wait-timeout', '60'],
      120_000,
    );
  } catch {
    rejected = true;
  }
  assert.equal(
    rejected,
    true,
    'missing committed identity file must fail startup',
  );
  assert.equal(await isRunning('api'), false);
  assert.equal(await isRunning('worker'), false);
  assert.deepEqual(await identityCounts(), {
    tenants: 2,
    principals: 6,
    credentials: 6,
    manifests: 1,
  });
  const capturedLogs = await compose(['logs', '--no-color']);
  const logs = capturedLogs.stdout + capturedLogs.stderr;
  assert.ok(logs.includes('initialization_failed'));
  assertNoGeneratedSecrets(logs);
  console.log(
    'Missing identity material blocked application startup without data loss or secret logs',
  );

  await compose(['down', '--remove-orphans']);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    'node',
    'secrets',
    '-e',
    "require('node:fs').unlinkSync('/run/lab/api/password')",
  ]);
  rejected = false;
  try {
    await compose(
      ['up', '--detach', '--wait', '--wait-timeout', '60'],
      120_000,
    );
  } catch {
    rejected = true;
  }
  assert.equal(
    rejected,
    true,
    'missing password must fail before PostgreSQL restarts',
  );
  assert.equal(await isRunning('postgres'), false);
  const check = await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    'node',
    'secrets',
    '-e',
    "console.log(require('node:fs').existsSync('/run/lab/api/password'))",
  ]);
  assert.equal(check.stdout.trim(), 'false');
  console.log(
    'Missing database password was rejected without automatic regeneration',
  );
} finally {
  // Only this uniquely named test project is removed; never target a developer installation.
  await compose(
    ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    120_000,
  );
}
