const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { createApi } = require('../apps/api/dist/app.js');

test('liveness responds while uninitialized readiness fails closed', async () => {
  const app = await createApi();
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const live = await fetch(`${url}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'alive' });
    const ready = await fetch(`${url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'not_ready' });
  } finally {
    await app.close();
  }
});

test('idle worker starts and shuts down on SIGTERM without an HTTP listener', async () => {
  const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    errors += chunk;
  });
  try {
    const started = new Promise((resolve, reject) => {
      lines.on('line', (line) => {
        if (JSON.parse(line).event === 'worker_idle') resolve();
      });
      child.on('error', reject);
      exit.then(() =>
        reject(new Error(`Worker exited before startup: ${errors}`)),
      );
    });
    await Promise.race([
      started,
      new Promise((_, reject) => {
        child.startupTimeout = setTimeout(
          () => reject(new Error('Worker startup timed out')),
          5000,
        );
      }),
    ]);
    child.kill('SIGTERM');
    const [code, signal] = await exit;
    expect(code).toBeNull();
    expect(signal).toBe('SIGTERM');
    expect(errors).toBe('');
  } finally {
    clearTimeout(child.startupTimeout);
    lines.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await exit;
  }
});
