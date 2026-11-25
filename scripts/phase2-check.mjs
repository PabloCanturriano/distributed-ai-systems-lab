import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const commands = [
  'check',
  'test:database',
  'test:tracing',
  'test:containers',
  'test:compose',
  'test:kafka',
  'test:relay',
  'test:consumer',
  'test:executor',
  'test:cli',
  'test:replay',
];
const required = [
  ...Array.from({ length: 5 }, (_, i) => `HTTP-0${i + 1}`),
  ...Array.from({ length: 3 }, (_, i) => `EVENT-0${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `DATA-0${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `CLI-0${i + 1}`),
  'SEC-01',
  'SEC-02',
  'SEC-03',
];
const report = {
  schemaVersion: 1,
  phase: 2,
  status: 'failed',
  baseRevision: '',
  sourceDigest: '',
  workingTreeDirty: true,
  node: process.versions.node,
  platform: process.platform,
  architecture: process.arch,
  gates: [],
  criteria: [],
  traceCorrelation: 'not-run',
};
function sourceDigest() {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .filter((name) =>
      /^(apps\/|packages\/|database\/|fixtures\/|scripts\/|tests\/|infra\/|\.github\/|package(?:-lock)?\.json$|.*config.*\.(?:json|cjs)$|compose\.yaml$|\.dockerignore$|\.gitignore$|\.prettierignore$|docs\/quality\/phase[234]-acceptance\.json$)/.test(
        name,
      ),
    );
  const digest = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    digest.update(file).update('\0').update(readFileSync(file)).update('\0');
  }
  return digest.digest('hex');
}
function validateEvidence(section) {
  if (
    !Array.isArray(section.gates) ||
    !section.gates.length ||
    section.gates.some((g) => !commands.includes(g)) ||
    !Array.isArray(section.evidence) ||
    !section.evidence.length
  )
    throw new Error('Invalid phase-2 evidence');
  for (const item of section.evidence) {
    if (
      typeof item.path !== 'string' ||
      item.path.includes('..') ||
      (!item.path.startsWith('tests/') && !item.path.startsWith('scripts/'))
    )
      throw new Error('Invalid phase-2 evidence');
    const source = readFileSync(item.path, 'utf8');
    if (
      typeof item.contains !== 'string' ||
      !source.includes(item.contains) ||
      /(?:test|it|describe)\.(?:skip|only)(?:\.|\s*\()/.test(source)
    )
      throw new Error('Invalid phase-2 evidence');
  }
}
try {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 3))
    throw new Error('Node 24.22.3 or later in the 24.x line required');
  const manifest = JSON.parse(
    readFileSync('docs/quality/phase2-acceptance.json', 'utf8'),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.phase !== 2 ||
    !Array.isArray(manifest.criteria) ||
    manifest.criteria.length !== required.length ||
    new Set(manifest.criteria.map((c) => c.id)).size !== required.length ||
    required.some((id) => !manifest.criteria.some((c) => c.id === id))
  )
    throw new Error('Invalid phase-2 manifest');
  for (const criterion of manifest.criteria) validateEvidence(criterion);
  validateEvidence(manifest.traceCorrelation);
  report.baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  report.sourceDigest = sourceDigest();
  report.workingTreeDirty =
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
      .length > 0;
  for (const command of commands) {
    console.log(`Phase 2: running ${command}`);
    const start = performance.now();
    const exit = await new Promise((resolve) => {
      const child = spawn('npm', ['run', command], {
        stdio: 'inherit',
        shell: false,
      });
      child.once('error', () => resolve(1));
      child.once('close', (code) => resolve(code ?? 1));
    });
    report.gates.push({
      command,
      status: exit === 0 ? 'passed' : 'failed',
      durationMs: Math.round(performance.now() - start),
    });
    if (exit !== 0) throw new Error('Phase-2 gate failed');
  }
  if (sourceDigest() !== report.sourceDigest)
    throw new Error('Implementation changed during verification');
  report.criteria = manifest.criteria.map((c) => ({
    id: c.id,
    status: 'passed',
    gates: c.gates,
  }));
  report.traceCorrelation = 'passed';
  report.status = 'passed';
} catch {
  console.error(
    'Phase 2 verification failed. A missing/failed gate or inconsistent evidence cannot count as complete.',
  );
  process.exitCode = 1;
} finally {
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/phase2-report.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      phase: 2,
      status: report.status,
      report: 'artifacts/phase2-report.json',
    }),
  );
}
