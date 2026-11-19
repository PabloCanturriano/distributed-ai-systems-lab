const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

for (const [role, setting] of [
  ['api', 'APP_MODE'],
  ['worker', 'APP_MODE'],
  ['api', 'API_PORT'],
  ['api', 'API_HOST'],
]) {
  test(`${role} rejects invalid ${setting} before starting and conceals its value`, async () => {
    const secret = 'fictional-secret-deployment-value';
    let failure;
    try {
      await run(process.execPath, [`apps/${role}/dist/main.js`], {
        env: {
          ...process.env,
          APP_MODE: 'local',
          API_DEPENDENCIES: 'disabled',
          [setting]: secret,
        },
        timeout: 3000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(failure.killed).toBe(false);
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toBe(
      `${JSON.stringify({ event: `${role}_start_failed` })}\n`,
    );
    expect(failure.stderr).not.toContain(secret);
  });
}

test('API uses its configured port and reports a safe failure when that port is occupied', async () => {
  const { createServer } = require('node:net');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    let failure;
    try {
      await run(process.execPath, ['apps/api/dist/main.js'], {
        env: {
          ...process.env,
          APP_MODE: 'local',
          API_DEPENDENCIES: 'disabled',
          API_HOST: '127.0.0.1',
          API_PORT: String(port),
        },
        timeout: 3000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(failure.killed).toBe(false);
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toBe('{"event":"api_start_failed"}\n');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
