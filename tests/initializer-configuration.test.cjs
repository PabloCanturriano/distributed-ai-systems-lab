const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);

test.each([
  ['bootstrap', 'fictional-sensitive-mode'],
  ['unsupported-action', 'local'],
])(
  'initializer rejects unsupported configuration with safe output (%s)',
  async (action, mode) => {
    let failure;
    try {
      await run(process.execPath, ['database/dist/initialize.js', action], {
        env: { ...process.env, APP_MODE: mode },
        timeout: 3000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(failure.killed).toBe(false);
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toBe('{"event":"initialization_failed"}\n');
  },
);
