import { spawn } from 'node:child_process';
// Fixed repository commands only. No Docker socket is exposed to the business CLI.
const catalog = {
  'delivery-repair': {
    script: 'scripts/operations-smoke.mjs',
    checkpoint: '"realKafkaSingleJob":true',
  },
  'crash-after-response': {
    script: 'scripts/response-crash-smoke.mjs',
    checkpoint: '"checkpointObserved":true',
  },
  'crash-after-publication': {
    script: 'scripts/relay-smoke.mjs',
    checkpoint:
      'Crash after broker acknowledgement recovered the lease and duplicated the same stable event',
  },
  'crash-after-scheduling': {
    script: 'scripts/consumer-smoke.mjs',
    checkpoint:
      'Crash after SQL commit during rebalance redelivered without replacing the job or skipping its offset',
  },
  'collector-outage': {
    script: 'scripts/observability-smoke.mjs',
    checkpoint: '"collectorOutageBusinessCompleted":true',
  },
};
const [command, name, ...extra] = process.argv.slice(2);
if (command === 'list' && !name && !extra.length) {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      command: 'scenario list',
      scenarios: Object.entries(catalog).map(([name, value]) => ({
        name,
        execution: 'host',
        checkpoint: value.checkpoint,
        fixtureVersion: 1,
      })),
    }),
  );
} else if (command === 'run' && Object.hasOwn(catalog, name) && !extra.length) {
  let observed = false,
    output = '';
  const child = spawn(process.execPath, [catalog[name].script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  child.stdout.on('data', (chunk) => {
    process.stderr.write(chunk);
    output = (output + chunk.toString()).slice(-16384);
    if (output.includes(catalog[name].checkpoint)) observed = true;
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(4));
    child.once('close', (code) => resolve(code ?? 4));
  });
  const passed = code === 0 && observed;
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      command: 'scenario run',
      name,
      fixtureVersion: 1,
      outcome: passed ? 'passed' : 'failed',
      checkpointObserved: observed,
    }),
  );
  process.exitCode = passed ? 0 : code === 0 ? 1 : 4;
} else {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      outcome: 'error',
      error: {
        code: 'INVALID_ARGUMENTS',
        message: 'Use list or run with an allowlisted scenario name.',
      },
    }),
  );
  process.exitCode = 2;
}
