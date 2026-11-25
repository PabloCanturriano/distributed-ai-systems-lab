const { spawnSync } = require('node:child_process');
test.each(['toString', 'constructor', '__proto__'])(
  'host scenario names must be declared entries: %s',
  (name) => {
    const result = spawnSync(
      process.execPath,
      ['scripts/scenarios.mjs', 'run', name],
      { encoding: 'utf8', timeout: 2000 },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      outcome: 'error',
      error: { code: 'INVALID_ARGUMENTS' },
    });
  },
);
