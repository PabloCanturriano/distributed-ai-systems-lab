import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const exec = promisify(execFile),
  project = `lab-retrieval-${process.pid}-${Date.now()}`;
const prefix = ['compose', '--project-name', project, '--file', 'compose.yaml'];
const docker = async (args, timeout = 40000, input) => {
  const p = exec('docker', args, { timeout, maxBuffer: 20 * 1024 * 1024 });
  p.child.stdin.end(input);
  return p;
};
const compose = (args, timeout, input) =>
  docker([...prefix, ...args], timeout, input);
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceDigest() {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .filter((name) =>
      /^(apps\/|packages\/|database\/|fixtures\/|scripts\/|tests\/|infra\/|\.github\/|package(?:-lock)?\.json$|.*config.*\.(?:json|cjs)$|compose\.yaml$|\.dockerignore$|\.gitignore$|\.prettierignore$|docs\/quality\/phase[2345]-acceptance\.json$)/.test(
        name,
      ),
    );
  const digest = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    digest.update(file).update('\0').update(readFileSync(file)).update('\0');
  }
  return digest.digest('hex');
}

const initialSourceDigest = sourceDigest();
const corpus = JSON.parse(
  readFileSync('fixtures/knowledge/corpus-v1.json', 'utf8'),
);
const dataset = JSON.parse(
  readFileSync('fixtures/evaluation/retrieval-v1.json', 'utf8'),
);
if (process.argv.length !== 2)
  throw Error('No evaluation arguments are supported');
assert.equal(dataset.corpusDigest, digest(corpus));
assert.equal(dataset.cases.length, 30);
assert.equal(new Set(dataset.cases.map((c) => c.id)).size, 30);
for (const c of dataset.cases) {
  assert(
    corpus.tenants.some(
      (t) => t.tenantId === c.tenantId && t.snapshotId === c.snapshotId,
    ),
  );
  assert.equal(c.answerable, c.expectedChunks.length > 0);
}
let report = {
  schemaVersion: 1,
  sourceDigest: initialSourceDigest,
  category: 'retrieval',
  embeddingModel: null,
  dimensions: 128,
  cutoff: 0.25,
  chunkingProfile: 'paragraph-utf8-v1',
  providerUsage: { applicable: false },
  mode: 'offline-lexical',
  status: 'failed',
  profile: dataset.profile,
  policy: dataset.policy,
  datasetVersion: dataset.version,
  datasetDigest: digest(dataset),
  corpusDigest: digest(corpus),
  baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  workingTreeDirty:
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
      .length > 0,
  cases: [],
};
try {
  console.log(
    'Evaluating the frozen 30-case lexical corpus with exact tenant-scoped pgvector search',
  );
  await compose(['build', 'executor'], 240000);
  await compose(['up', '--build', '--detach', 'seed'], 180000);
  await compose(['wait', 'seed'], 180000);
  const seedId = (
    await compose(['ps', '--all', '--quiet', 'seed'])
  ).stdout.trim();
  assert.equal(
    JSON.parse((await docker(['inspect', seedId])).stdout)[0].State.ExitCode,
    0,
  );
  const actor = readFileSync(
    new URL('./retrieval-eval-actor.mjs', import.meta.url),
    'utf8',
  );
  const result = await compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      'executor',
      '--input-type=module',
      '-e',
      actor,
    ],
    60000,
    JSON.stringify(dataset),
  );
  const cases = JSON.parse(result.stdout).cases;
  assert.equal(
    sourceDigest(),
    initialSourceDigest,
    'Evaluation sources changed during the run',
  );
  assert.equal(cases.length, 30);
  const answerable = cases.filter((c) => c.answerable),
    recall = (values) =>
      values.reduce((sum, c) => sum + c.recallAt5, 0) / values.length;
  const bySplit = Object.fromEntries(
    ['tuning', 'holdout'].map((split) => {
      const subset = answerable.filter((c) => c.split === split);
      return [
        split,
        { answerableCases: subset.length, macroRecallAt5: recall(subset) },
      ];
    }),
  );
  report = {
    ...report,
    status: 'passed',
    sampleCount: cases.length,
    answerableCases: answerable.length,
    macroRecallAt5: recall(answerable),
    target: { hypothesis: 0.8, met: recall(answerable) >= 0.8 },
    bySplit,
    candidateConfusion: {
      answerableWithCandidates: answerable.filter(
        (c) => c.retrievedChunks.length,
      ).length,
      answerableWithoutCandidates: answerable.filter(
        (c) => !c.retrievedChunks.length,
      ).length,
      unanswerableWithCandidates: cases.filter(
        (c) => !c.answerable && c.retrievedChunks.length,
      ).length,
      unanswerableWithoutCandidates: cases.filter(
        (c) => !c.answerable && !c.retrievedChunks.length,
      ).length,
    },
    missedCaseIds: answerable.filter((c) => c.recallAt5 < 1).map((c) => c.id),
    cases,
  };
  console.log(
    JSON.stringify({
      category: report.category,
      mode: report.mode,
      status: report.status,
      samples: report.sampleCount,
      macroRecallAt5: report.macroRecallAt5,
      targetMet: report.target.met,
      missedCaseIds: report.missedCaseIds,
    }),
  );
} finally {
  try {
    await compose(
      ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
      90000,
    );
    report.cleanup = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.cleanup = 'failed';
    throw error;
  } finally {
    mkdirSync('artifacts', { recursive: true });
    writeFileSync(
      'artifacts/retrieval-v1-report.json',
      JSON.stringify(report, null, 2) + '\n',
    );
  }
}
