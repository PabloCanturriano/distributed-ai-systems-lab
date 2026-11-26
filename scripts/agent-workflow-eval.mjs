import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const {
  runBoundedAgent,
  ScriptedAgentModel,
  AgentError,
} = require('../apps/worker/dist/bounded-agent');
if (process.argv.length !== 2)
  throw Error('No evaluation arguments are supported');
const dataset = JSON.parse(
  readFileSync('fixtures/evaluation/agent-workflow-v1.json', 'utf8'),
);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function sourceDigest() {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter((name) =>
      /^(apps\/|packages\/|database\/|fixtures\/|scripts\/|tests\/|infra\/|\.github\/|package(?:-lock)?\.json$|.*config.*\.(?:json|cjs)$|compose\.yaml$|\.dockerignore$|\.gitignore$|\.prettierignore$|docs\/quality\/phase[2345]-acceptance\.json$)/.test(
        name,
      ),
    );
  const digest = createHash('sha256');
  for (const file of [...new Set(files)].sort())
    digest.update(file).update('\0').update(readFileSync(file)).update('\0');
  return digest.digest('hex');
}
assert.equal(dataset.version, 'agent-workflow-v1');
assert.equal(dataset.policy, 'bounded-agent-v1');
assert.equal(dataset.mode, 'offline-scripted');
assert.equal(dataset.cases.length, 12);
assert.equal(new Set(dataset.cases.map((c) => c.id)).size, 12);
const report = {
  schemaVersion: 1,
  category: 'workflow',
  mode: 'offline-scripted',
  status: 'failed',
  policy: dataset.policy,
  datasetVersion: dataset.version,
  datasetDigest: hash(JSON.stringify(dataset)),
  sourceDigest: sourceDigest(),
  baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  workingTreeDirty:
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
      .length > 0,
  provider: 'scripted-fixture-v1',
  model: null,
  toolBackend: 'deterministic-fixtures',
  providerUsage: { applicable: false },
  semanticQualityEvaluated: false,
  sampleCount: dataset.cases.length,
  cases: [],
  failures: [],
};
const allowed = new Set([
  'search_documentation',
  'get_service_status',
  'get_ticket',
]);
try {
  for (const c of dataset.cases) {
    const executedTools = [],
      started = performance.now();
    let searches = 0,
      forbiddenToolAttempts = 0;
    const scripted = new ScriptedAgentModel(c.decisions);
    const model = {
      mode: 'simulated',
      async decide(input, signal) {
        const decision = await scripted.decide(input, signal);
        if (decision?.kind === 'tool' && !allowed.has(decision.name))
          forbiddenToolAttempts++;
        return decision;
      },
    };
    const tools = {
      async search() {
        if (searches++ > 0) executedTools.push('search_documentation');
        return structuredClone(c.evidence);
      },
      async serviceStatus() {
        executedTools.push('get_service_status');
        return { code: 'NOT_FOUND' };
      },
      async ticket() {
        executedTools.push('get_ticket');
        return { code: 'NOT_FOUND' };
      },
    };
    let outcome = null,
      error = null;
    try {
      outcome = (
        await runBoundedAgent({
          context: dataset.scope,
          question: c.question,
          model,
          tools,
          signal: new AbortController().signal,
        })
      ).result.outcome;
    } catch (failure) {
      error =
        failure instanceof AgentError ? failure.code : 'UNEXPECTED_FAILURE';
    }
    let passed = true;
    try {
      assert.equal(error, c.expected.error);
      assert.equal(outcome, c.expected.outcome);
      assert.deepEqual(executedTools, c.expected.executedTools);
      assert.equal(forbiddenToolAttempts, c.expected.forbiddenToolAttempts);
      assert(executedTools.every((name) => allowed.has(name)));
    } catch {
      passed = false;
      report.failures.push(c.id);
    }
    report.cases.push({
      id: c.id,
      passed,
      outcome,
      error,
      forbiddenToolAttempts,
      forbiddenToolExecutions: executedTools.filter(
        (name) => !allowed.has(name),
      ).length,
      executedTools,
      latencyMs: performance.now() - started,
    });
  }
  assert.equal(
    sourceDigest(),
    report.sourceDigest,
    'Source changed during evaluation',
  );
  if (report.failures.length === 0) report.status = 'passed';
} finally {
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/agent-workflow-v1-report.json',
    JSON.stringify(report, null, 2) + '\n',
  );
}
console.log(
  JSON.stringify({
    event: 'agent_workflow_evaluation',
    status: report.status,
    sampleCount: report.sampleCount,
    failures: report.failures,
  }),
);
if (report.status !== 'passed') process.exitCode = 1;
