import { localTelemetry } from '@lab/telemetry';
import { loadExecutorConfiguration } from '@lab/configuration';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Pool } from 'pg';
import { ExecutionOwnership } from './execution-ownership';
import { JobExecutor } from './job-executor';
import { EvidenceProvider } from './evidence-provider';
import { ExecutionEvidence } from './execution-evidence';
import { KnowledgeRetrieval } from './knowledge-retrieval';

const controller = new AbortController();
const report = (event: string) => console.log(JSON.stringify({ event }));
let deadline: ReturnType<typeof setTimeout> | undefined;
function stop() {
  if (controller.signal.aborted) return;
  controller.abort();
  deadline = setTimeout(() => {
    report('executor_shutdown_deadline');
    process.exit(1);
  }, 12000);
  deadline.unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
async function password() {
  const file = await open(
    '/run/lab/worker/password',
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size !== 43
    )
      throw new Error('Invalid worker credential');
    const value = await file.readFile('utf8');
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, 'base64url').toString('base64url') !== value
    )
      throw new Error('Invalid worker credential');
    return value;
  } finally {
    await file.close();
  }
}
async function main() {
  const config = loadExecutorConfiguration(process.env),
    credential = await password();
  if (controller.signal.aborted) return;
  const pool = new Pool({
    ...config.postgres,
    database: 'lab',
    user: 'lab_worker_login',
    password: credential,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 1000,
    query_timeout: 6000,
    statement_timeout: 5000,
    idleTimeoutMillis: 1000,
    application_name: 'lab-job-executor',
  });
  pool.on('error', () => report('executor_database_unavailable'));
  const telemetry = localTelemetry('lab-worker', 'executor');
  try {
    report('executor_started');
    await new JobExecutor(
      new ExecutionOwnership(pool, telemetry),
      new EvidenceProvider(
        new ExecutionEvidence(pool),
        new KnowledgeRetrieval(pool),
        telemetry,
      ),
      report,
      telemetry,
    ).run(controller.signal);
  } finally {
    stop();
    await Promise.allSettled([pool.end(), telemetry.shutdown()]);
  }
}
void main()
  .catch(() => {
    report('executor_failed');
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(deadline);
    report('executor_stopped');
  });
