import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  createReadStream,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { releasePlan, assessReleaseImage } from './release-policy.mjs';

const [version, destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length)
  throw Error(
    'Usage: node scripts/prepare-release.mjs <version> <output-directory>',
  );
const run = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });
if (run('git', ['status', '--porcelain']).trim())
  throw Error('Release source must be committed and clean');
const plan = releasePlan(version, run('git', ['rev-parse', 'HEAD']).trim());
const architecture = JSON.parse(
  run('docker', ['info', '--format', '{{json .Architecture}}']),
);
const arch =
  architecture === 'aarch64'
    ? 'arm64'
    : architecture === 'x86_64'
      ? 'amd64'
      : architecture;
if (!['amd64', 'arm64'].includes(arch))
  throw Error('Unsupported release architecture');
const root = resolve(destination, arch);
mkdirSync(root, { recursive: true });
if (readdirSync(root).length)
  throw Error('Release output directory must be empty');
const scanner = process.env.TRIVY_BIN;
if (!scanner) throw Error('TRIVY_BIN must identify the pinned scanner');
const images = [],
  blocked = [];
const baseRef = readFileSync('infra/docker/Dockerfile', 'utf8').match(
  /^FROM (node:[^ ]+@sha256:[a-f0-9]{64}) AS manifests$/m,
)?.[1];
if (!baseRef) throw Error('Pinned Node base identity is required');
run('docker', ['pull', baseRef]);
const baseImage = JSON.parse(run('docker', ['image', 'inspect', baseRef]))[0]
  .Id;
run(process.execPath, [
  'scripts/export-image-notices.mjs',
  baseImage,
  join(root, 'base-node.notices'),
]);
const baseNotices = JSON.parse(
  readFileSync(join(root, 'base-node.notices/manifest.json'), 'utf8'),
);
if (
  baseNotices.packages.some(
    (pkg) => pkg.missingLicenseText || !pkg.declaredLicense,
  ) ||
  baseNotices.skippedLinks.length
)
  blocked.push({
    role: 'base-node',
    issues: ['incomplete_inherited_layer_notices'],
  });
for (const role of plan.roles) {
  const local = `lab-release-${role}:${plan.revision}-${arch}`;
  console.log(JSON.stringify({ event: 'release_image_build', role, arch }));
  run('docker', [
    'build',
    '--file',
    'infra/docker/Dockerfile',
    '--target',
    role,
    '--tag',
    local,
    '.',
  ]);
  const image = JSON.parse(run('docker', ['image', 'inspect', local]))[0].Id;
  const reportPath = join(root, `${role}.scan.json`);
  run(scanner, [
    'image',
    '--image-src',
    'docker',
    '--scanners',
    'vuln,license',
    '--license-full',
    '--format',
    'json',
    '--output',
    reportPath,
    image,
  ]);
  run(scanner, [
    'convert',
    '--format',
    'cyclonedx',
    '--output',
    join(root, `${role}.sbom.cdx.json`),
    reportPath,
  ]);
  run(process.execPath, [
    'scripts/export-image-notices.mjs',
    image,
    join(root, `${role}.notices`),
  ]);
  const notices = JSON.parse(
    readFileSync(join(root, `${role}.notices/manifest.json`), 'utf8'),
  );
  const issues = assessReleaseImage(
    JSON.parse(readFileSync(reportPath, 'utf8')),
    notices,
    image,
    arch,
  );
  if (issues.length) blocked.push({ role, issues });
  images.push({ role, local, image, architecture: arch });
}
if (!blocked.length)
  for (const image of images)
    run('docker', [
      'save',
      '--output',
      join(root, `${image.role}.tar`),
      image.local,
    ]);
const checksums = {};
async function inventory(path, prefix = '') {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const name = prefix + entry.name;
    if (entry.isDirectory())
      await inventory(join(path, entry.name), name + '/');
    else if (entry.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(join(path, entry.name)))
        hash.update(chunk);
      checksums[name] = hash.digest('hex');
    } else throw Error('Unexpected release artifact type');
  }
}
await inventory(root);
writeFileSync(
  join(root, 'manifest.json'),
  JSON.stringify(
    { ...plan, architecture: arch, images, blocked, checksums },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    event: 'release_candidate_prepared',
    arch,
    images: images.length,
    blocked,
  }),
);
if (blocked.length) process.exitCode = 1;
