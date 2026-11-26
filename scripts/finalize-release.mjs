import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { releasePlan, releaseImageOverrides } from './release-policy.mjs';
const [version, artifacts, revision, ...extra] = process.argv.slice(2);
if (!artifacts || extra.length)
  throw Error(
    'Usage: node scripts/finalize-release.mjs <version> <artifact-directory> <revision>',
  );
releasePlan(version, revision);
const manifestPath = resolve(artifacts, 'published-manifest.json');
const published = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (published.version !== version) throw Error('Release version mismatch');
releaseImageOverrides(published, revision);
for (const architecture of ['amd64', 'arm64']) {
  const report = JSON.parse(
    readFileSync(resolve(artifacts, architecture + '-journey.json'), 'utf8'),
  );
  if (
    report.status !== 'passed' ||
    report.cleanup !== 'passed' ||
    report.category !== 'published-image-quickstart' ||
    report.source?.baseRevision !== revision ||
    JSON.stringify(report.publishedImages) !==
      JSON.stringify(published.images) ||
    report.docker?.architecture !==
      (architecture === 'arm64' ? 'aarch64' : 'x86_64')
  )
    throw Error(
      'Published image journey is not verified on both architectures',
    );
}
const run = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });
const notes = resolve(artifacts, 'release-notes.md');
writeFileSync(
  notes,
  `Evaluation candidate for local use. Not a production or security-supported service.\n\nSource: ${revision}\n\nUse the immutable image references in the attached manifest. Review the documented limitations, image findings and per-architecture package/license bundles before use.\n`,
);
const bundles = [];
for (const architecture of ['amd64', 'arm64']) {
  const bundle = resolve(artifacts, `${architecture}-evidence.tar.gz`);
  run('tar', [
    '--exclude=*.tar',
    '-czf',
    bundle,
    '-C',
    resolve(artifacts),
    architecture,
  ]);
  bundles.push(bundle);
}
run('gh', [
  'release',
  'create',
  version,
  '--repo',
  'PabloCanturriano/distributed-ai-systems-lab',
  '--target',
  revision,
  '--prerelease',
  '--title',
  version,
  '--notes-file',
  notes,
  manifestPath,
  ...bundles,
]);
