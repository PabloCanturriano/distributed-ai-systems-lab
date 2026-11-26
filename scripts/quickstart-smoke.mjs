import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotSource, implementationDigest } from './reviewer-snapshot.mjs';
import { releaseImageOverrides } from './release-policy.mjs';
const [option, manifestFile, ...extra] = process.argv.slice(2);
if (
  (option && (option !== '--images' || !manifestFile)) ||
  (!option && manifestFile) ||
  extra.length
)
  throw Error('Use no arguments or --images <published-manifest.json>');
const published = manifestFile
  ? JSON.parse(readFileSync(manifestFile, 'utf8'))
  : null;
const root = process.cwd(),
  temporary = mkdtempSync(join(tmpdir(), 'lab-reviewer-')),
  source = join(temporary, 'source');
mkdirSync(source);
const project = `lab-quickstart-${process.pid}-${Date.now()}`,
  exec = promisify(execFile),
  env = { ...process.env, LAB_API_PORT: '0', LAB_TELEMETRY_MODE: 'local' };
const report = {
  schemaVersion: 1,
  category: 'reviewer-quickstart',
  status: 'failed',
  source: null,
  implementationDigest: implementationDigest(root),
  controller: {
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
  },
  docker: null,
  composeVersion: null,
  startupMs: null,
  cliBuildMs: null,
  buildAndStartupMs: null,
  buildCache: 'existing Docker build cache may be used',
  cleanVolumes: true,
  hostApplicationDependencies: false,
  checks: [],
  resourceSamples: [],
  cleanup: 'not-run',
  failureStage: null,
  failureCode: null,
};
let stage = 'snapshot',
  started = false;
const composePrefix = [
  'compose',
  '--project-name',
  project,
  '--file',
  'compose.yaml',
  '--profile',
  'messaging',
  '--profile',
  'execution',
];
async function docker(args, timeout = 40000) {
  return exec('docker', args, {
    cwd: source,
    env,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
}
const compose = (args, timeout) => docker([...composePrefix, ...args], timeout);
async function cli(args) {
  const result = await compose(
    ['run', '--rm', '--no-deps', '-T', 'cli', ...args, '--json'],
    90000,
  );
  return JSON.parse(result.stdout);
}
async function sample(checkpoint) {
  const ids = (await compose(['ps', '--quiet'])).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!ids.length) throw Error('No quickstart containers');
  const lines = (
    await docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids])
  ).stdout
    .trim()
    .split('\n');
  report.resourceSamples.push({
    checkpoint,
    containers: lines.map((line) => {
      const row = JSON.parse(line);
      return {
        service: row.Name.replace(project + '-', '').replace(/-\d+$/, ''),
        cpuPercent: row.CPUPerc,
        memoryUsage: row.MemUsage,
        memoryPercent: row.MemPerc,
      };
    }),
  });
}
try {
  report.source = snapshotSource(root, source);
  if (published) {
    const override = releaseImageOverrides(
      published,
      report.source.baseRevision,
    );
    writeFileSync(
      join(source, 'release-images.json'),
      JSON.stringify(override),
    );
    composePrefix.push('--file', 'release-images.json');
    report.category = 'published-image-quickstart';
    report.publishedImages = published.images;
  }
  stage = 'engine';
  report.docker = JSON.parse(
    (
      await docker([
        'info',
        '--format',
        '{"serverVersion":{{json .ServerVersion}},"architecture":{{json .Architecture}},"cpus":{{json .NCPU}},"memoryBytes":{{json .MemTotal}}}',
      ])
    ).stdout,
  );
  report.composeVersion = (
    await docker(['compose', 'version', '--short'])
  ).stdout.trim();
  stage = 'build';
  started = true;
  const buildStart = performance.now();
  if (published) {
    for (const image of published.images)
      await docker(['pull', image.ref], 240000);
    // Only the tiny source-controlled broker bootstrap remains source-built.
    await compose(['build', 'kafka-init'], 240000);
  } else await compose(['build', 'cli'], 240000);
  report.cliBuildMs = Math.round(performance.now() - buildStart);
  stage = 'startup';
  const start = performance.now();
  started = true;
  await compose(
    [
      'up',
      published ? '--no-build' : '--build',
      '--detach',
      '--wait',
      '--wait-timeout',
      '180',
    ],
    360000,
  );
  report.startupMs = Math.round(performance.now() - start);
  report.buildAndStartupMs = Math.round(performance.now() - buildStart);
  await sample('ready');
  stage = 'demo';
  for (const alias of ['harbor.requester', 'summit.requester']) {
    const result = (
      await cli(['demo', '--identity', alias, '--deadline', '60'])
    ).ticket;
    assert.equal(result.status, 'completed');
    assert.equal(result.result.outcome, 'answered');
    assert(result.result.citations.length > 0);
    assert.equal(result.result.execution.policy, 'bounded-agent-v1');
    assert.equal(result.result.execution.toolCalls.length, 3);
  }
  report.checks.push('two-tenant-cited-demo');
  await sample('demo-completed');
  stage = 'duplicate';
  const key = randomUUID();
  const args = ['ticket', 'create', '--message', 'retry policy', '--key', key];
  const first = await cli(args),
    second = await cli(args);
  assert.deepEqual(first.ticket, second.ticket);
  await cli(['ticket', 'wait', first.ticket.ticketId, '--deadline', '60']);
  report.checks.push('same-key-same-receipt');
  stage = 'queued-recovery';
  await compose(['stop', 'executor']);
  const queued = await cli([
    'ticket',
    'create',
    '--message',
    'retry policy',
    '--key',
    randomUUID(),
  ]);
  assert.equal(
    (await cli(['ticket', 'get', queued.ticket.ticketId])).ticket.status,
    'queued',
  );
  await sample('executor-stopped');
  await compose(['start', 'executor']);
  const recovered = (
    await cli(['ticket', 'wait', queued.ticket.ticketId, '--deadline', '60'])
  ).ticket;
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result.execution.policy, 'bounded-agent-v1');
  report.checks.push('stopped-executor-recovers-queued-work');
  await sample('recovered');
  stage = 'source-identity';
  assert.equal(implementationDigest(root), report.implementationDigest);
  report.status = 'passed';
} catch (error) {
  report.failureCode = Number.isInteger(error.code)
    ? 'EXIT_' + error.code
    : /^[A-Z_]{1,64}$/.test(error.code ?? '')
      ? error.code
      : 'DRIVER_FAILURE';
  report.failureStage = stage;
  process.exitCode = 1;
} finally {
  try {
    if (started)
      await compose(
        ['down', '--volumes', '--remove-orphans', '--rmi', 'local'],
        90000,
      );
    report.cleanup = 'passed';
  } catch {
    report.cleanup = 'failed';
    report.status = 'failed';
    process.exitCode = 1;
  }
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(
    join(root, 'artifacts/reviewer-quickstart-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      event: 'reviewer_quickstart',
      status: report.status,
      checks: report.checks,
      startupMs: report.startupMs,
      cleanup: report.cleanup,
      failureStage: report.failureStage,
    }),
  );
}
