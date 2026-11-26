import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { releasePlan } from './release-policy.mjs';

const [version, artifacts, revision, ...extra] = process.argv.slice(2);
if (!artifacts || extra.length)
  throw Error(
    'Usage: node scripts/publish-release.mjs <version> <artifact-directory> <revision>',
  );
const plan = releasePlan(version, revision);
const gates = JSON.parse(
  readFileSync(new URL('../docs/release/gates.json', import.meta.url), 'utf8'),
);
if (
  gates.schemaVersion !== 1 ||
  gates.targetVersion !== version ||
  !Array.isArray(gates.openIssues) ||
  gates.openIssues.length
)
  throw Error('Documented release gates are not closed');
const run = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });
const manifests = [];
for (const architecture of ['amd64', 'arm64']) {
  const root = resolve(artifacts, architecture);
  const manifest = JSON.parse(
    readFileSync(join(root, 'manifest.json'), 'utf8'),
  );
  if (
    manifest.revision !== revision ||
    manifest.version !== version ||
    manifest.architecture !== architecture ||
    manifest.registry !== plan.registry ||
    manifest.blocked?.length !== 0 ||
    JSON.stringify(manifest.images?.map((x) => x.role)) !==
      JSON.stringify(plan.roles)
  )
    throw Error('Unapproved or mismatched release candidate');
  for (const [name, digest] of Object.entries(manifest.checksums)) {
    const path = resolve(root, name);
    if (!path.startsWith(root + sep) || !/^[a-f0-9]{64}$/.test(digest))
      throw Error('Invalid artifact identity');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== digest)
      throw Error('Release artifact checksum mismatch');
  }
  for (const item of manifest.images) {
    if (
      !manifest.checksums[`${item.role}.tar`] ||
      !/^sha256:[a-f0-9]{64}$/.test(item.image) ||
      item.architecture !== architecture
    )
      throw Error('Missing immutable image artifact');
    run('docker', ['load', '--input', join(root, `${item.role}.tar`)]);
    const loaded = JSON.parse(
      run('docker', ['image', 'inspect', item.image]),
    )[0];
    if (
      loaded.Id !== item.image ||
      loaded.Architecture !== architecture ||
      loaded.Os !== 'linux'
    )
      throw Error('Loaded image identity mismatch');
  }
  manifests.push(manifest);
}
// Verify all inputs before the first registry mutation. Existing source tags are never moved.
try {
  run('git', [
    'ls-remote',
    '--exit-code',
    '--tags',
    'origin',
    `refs/tags/${version}`,
  ]);
  throw Error('Release source tag already exists');
} catch (error) {
  if (error.status !== 2) throw error;
}
const published = [];
for (const role of plan.roles) {
  const archRefs = [];
  for (const manifest of manifests) {
    const item = manifest.images.find((x) => x.role === role);
    const ref = `${plan.registry}/${role}:${version}-${manifest.architecture}-${revision}`;
    run('docker', ['tag', item.image, ref]);
    run('docker', ['push', ref]);
    archRefs.push(ref);
  }
  const ref = `${plan.registry}/${role}:${version}`;
  run('docker', ['buildx', 'imagetools', 'create', '--tag', ref, ...archRefs]);
  const raw = JSON.parse(
    run('docker', ['buildx', 'imagetools', 'inspect', '--raw', ref]),
  );
  const architectures = [
    ...new Set(
      (raw.manifests ?? [])
        .filter((x) => x.platform?.os === 'linux')
        .map((x) => x.platform.architecture),
    ),
  ].sort();
  if (JSON.stringify(architectures) !== JSON.stringify(['amd64', 'arm64']))
    throw Error('Published architecture manifest mismatch');
  const inspected = run('docker', ['buildx', 'imagetools', 'inspect', ref]);
  const digest = inspected.match(/^Digest:\s+(sha256:[a-f0-9]{64})$/m)?.[1];
  if (!digest) throw Error('Published manifest digest unavailable');
  published.push({
    role,
    ref: `${plan.registry}/${role}@${digest}`,
    architectures,
  });
}
const manifestPath = resolve(artifacts, 'published-manifest.json');
writeFileSync(
  manifestPath,
  JSON.stringify({ ...plan, images: published }, null, 2) + '\n',
);
