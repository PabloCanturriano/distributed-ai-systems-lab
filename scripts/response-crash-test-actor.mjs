// Trusted test-only process, injected by the host harness; absent from images.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire('/app/apps/worker/package.json');
const { Pool } = require('pg');
const { ExecutionOwnership } = require('./dist/execution-ownership.js');
const { JobExecutor } = require('./dist/job-executor.js');
const { AgentProvider } = require('./dist/agent-provider.js');
const mode = process.argv[1];
if (!['hold-response', 'recover'].includes(mode))
  throw Error('Invalid fixture');
const pool = new Pool({
  host: 'postgres',
  database: 'lab',
  user: 'lab_worker_login',
  password: readFileSync('/run/lab/worker/password', 'utf8'),
  max: 2,
  connectionTimeoutMillis: 1000,
  statement_timeout: 5000,
});
pool.on('error', () => {});
const ownership = new ExecutionOwnership(pool),
  provider = new AgentProvider(
    pool,
    JSON.parse(readFileSync('fixtures/knowledge/services-v1.json', 'utf8')),
  );
const store = {
  claim: () => ownership.claim(),
  renew: (...args) => ownership.renew(...args),
  retry: (...args) => ownership.retry(...args),
  fail: (...args) => ownership.fail(...args),
  complete: async (...args) => {
    if (mode === 'hold-response') {
      console.log(
        JSON.stringify({
          checkpoint: 'response-before-persistence',
          jobId: args[0],
          attemptId: args[1],
          evidenceCount: args[2].agent.evidence.length,
        }),
      );
      await new Promise(() => {});
    }
    return ownership.complete(...args);
  },
};
const wrappedProvider = {
  execute: async (claim, signal) => {
    const result = await provider.execute(claim, signal);
    console.log(
      JSON.stringify({
        checkpoint: 'provider-response',
        attemptNumber: claim.attemptNumber,
      }),
    );
    return result;
  },
};
try {
  await new JobExecutor(store, wrappedProvider, (event) =>
    console.log(JSON.stringify({ event })),
  ).runOnce(new AbortController().signal);
} finally {
  await pool.end();
}
