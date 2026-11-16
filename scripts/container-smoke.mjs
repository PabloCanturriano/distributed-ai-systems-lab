import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const runId = `lab-smoke-${process.pid}-${Date.now()}`;
const containers = [];
const images = [];

async function docker(args, timeout = 20_000) {
  return exec('docker', args, { timeout, maxBuffer: 10 * 1024 * 1024 });
}

async function waitFor(check, description) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  for (const role of ['api', 'worker']) {
    const image = `${runId}-${role}:local`;
    console.log(`Building ${role} image`);
    await docker(
      [
        'build',
        '--file',
        'infra/docker/Dockerfile',
        '--target',
        role,
        '--tag',
        image,
        '.',
      ],
      300_000,
    );
    images.push(image);
    const name = `${runId}-${role}`;
    containers.push(name);
    const options = [
      'run',
      '--detach',
      '--name',
      name,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
    ];
    if (role === 'api') options.push('--publish', '127.0.0.1::3000');
    await docker([...options, image]);

    const inspection = JSON.parse((await docker(['inspect', name])).stdout)[0];
    assert.equal(inspection.Config.User, 'node');
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspection.HostConfig.Privileged, false);
    assert.deepEqual(inspection.HostConfig.CapDrop, ['ALL']);
    assert.ok(inspection.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.equal(inspection.Mounts.length, 0);
    if (role === 'api') {
      const bindings = inspection.NetworkSettings.Ports['3000/tcp'];
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0].HostIp, '127.0.0.1');
      const url = `http://127.0.0.1:${bindings[0].HostPort}`;
      await waitFor(async () => {
        try {
          return (
            (
              await fetch(`${url}/health/live`, {
                signal: AbortSignal.timeout(1000),
              })
            ).status === 200
          );
        } catch {
          return false;
        }
      }, 'API liveness');
      const ready = await fetch(`${url}/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(ready.status, 503);
      assert.deepEqual(await ready.json(), { status: 'not_ready' });
      await waitFor(
        async () =>
          (
            await docker([
              'inspect',
              '--format',
              '{{.State.Health.Status}}',
              name,
            ])
          ).stdout.trim() === 'healthy',
        'API liveness healthcheck',
      );
    } else {
      assert.deepEqual(inspection.NetworkSettings.Ports, {});
      await waitFor(
        async () =>
          (await docker(['logs', name])).stdout.includes(
            '"event":"worker_idle"',
          ),
        'idle worker startup',
      );
    }

    const absentRole = role === 'api' ? 'worker' : 'api';
    await docker([
      'exec',
      name,
      'node',
      '-e',
      `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.ok(process.getuid() > 0);
      require('@lab/configuration');
      for (const path of ['.git', '.env', 'tests', 'node_modules/jest', 'node_modules/typescript', 'apps/${role}/src', 'apps/${absentRole}/dist']) {
        assert.equal(fs.existsSync(path), false, path + ' must be absent');
      }
    `,
    ]);
    await docker(['stop', '--time', '15', name]);
    const stopped = JSON.parse((await docker(['inspect', name])).stdout)[0];
    assert.equal(stopped.State.Running, false);
    assert.ok(
      [0, 143].includes(stopped.State.ExitCode),
      `shutdown must finish normally or on SIGTERM, got ${stopped.State.ExitCode}`,
    );

    const rejectedName = `${runId}-${role}-invalid`;
    containers.push(rejectedName);
    let rejected;
    try {
      await docker([
        'run',
        '--name',
        rejectedName,
        '--network',
        'none',
        '--read-only',
        '--env',
        'APP_MODE=fictional-sensitive-value',
        image,
      ]);
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected, 'unsupported mode must fail');
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout, '');
    assert.equal(
      rejected.stderr,
      `${JSON.stringify({ event: `${role}_start_failed` })}\n`,
    );
    console.log(
      `${role}: startup, isolation, safe rejection, and shutdown passed`,
    );
  }
} finally {
  // Remove only uniquely named resources created by this run. Never prune the daemon.
  const failures = [];
  for (const name of containers) {
    try {
      await docker(['rm', '--force', name]);
    } catch (error) {
      if (!error.stderr?.includes('No such container')) failures.push(name);
    }
  }
  for (const image of images) {
    try {
      await docker(['image', 'rm', image]);
    } catch {
      failures.push(image);
    }
  }
  if (failures.length) {
    console.error(`Could not clean up smoke resources: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}
