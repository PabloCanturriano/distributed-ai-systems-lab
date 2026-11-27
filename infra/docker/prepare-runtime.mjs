import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  statSync,
  existsSync,
  chmodSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export function parseSharedLibraries(text) {
  const paths = [];
  for (const line of text.split('\n').filter((x) => x.trim())) {
    if (/^\s*linux-vdso\.so(?:\.\d+)?\s+\(0x[0-9a-f]+\)\s*$/.test(line))
      continue;
    const path = line.match(
      /^\s*(?:\S+\s+=>\s+)?(\/\S+)\s+\(0x[0-9a-f]+\)\s*$/,
    )?.[1];
    if (
      !path ||
      !/^\/(?:usr\/)?lib(?:64)?\//.test(path) ||
      path.split('/').includes('..')
    )
      throw Error('Unresolved or unreviewed runtime library');
    paths.push(path);
  }
  if (!paths.length) throw Error('No dynamic runtime libraries identified');
  return [...new Set(paths)];
}

function prepare(root, dockerfile) {
  if (process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch))
    throw Error('Unsupported runtime platform');
  const sourceImage = readFileSync(dockerfile, 'utf8').match(
    /^FROM (node:[^ ]+@sha256:[a-f0-9]{64}) AS manifests$/m,
  )?.[1];
  if (!sourceImage) throw Error('Pinned Node provenance required');
  const selected = new Set([
    '/usr/local/bin/node',
    '/usr/local/LICENSE',
    '/etc/os-release',
    '/etc/debian_version',
  ]);
  for (const path of parseSharedLibraries(
    execFileSync('ldd', ['/usr/local/bin/node'], { encoding: 'utf8' }),
  )) {
    let owner;
    for (const candidate of [
      path,
      path.replace(/^\/lib\//, '/usr/lib/'),
      path.replace(/^\/lib64\//, '/usr/lib64/'),
    ]) {
      try {
        owner = execFileSync('dpkg-query', ['-S', candidate], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .split(': ')[0]
          .split(':')[0];
        break;
      } catch {}
    }
    if (!['libc6', 'libgcc-s1', 'libstdc++6'].includes(owner))
      throw Error('Unreviewed runtime library owner');
    selected.add(path);
  }
  for (const path of execFileSync('dpkg-query', ['-L', 'libc6'], {
    encoding: 'utf8',
  }).split('\n'))
    if (/\/libnss_(?:dns|files)\.so\.2$/.test(path) && existsSync(path))
      selected.add(path);
  for (const name of readdirSync('/usr/share/common-licenses'))
    selected.add('/usr/share/common-licenses/' + name);
  const packages = new Set(['base-files', 'libc6', 'libgcc-s1', 'libstdc++6']);
  if (existsSync('/etc/ssl/certs/ca-certificates.crt')) {
    selected.add('/etc/ssl/certs/ca-certificates.crt');
    packages.add('ca-certificates');
  }
  const status = readFileSync('/var/lib/dpkg/status', 'utf8')
    .trim()
    .split(/\n\n+/)
    .filter((block) => packages.has(block.match(/^Package: (.+)$/m)?.[1]));
  if (status.length !== packages.size)
    throw Error('Retained package metadata is incomplete');
  const osPackages = status
    .map((block) => {
      const name = block.match(/^Package: (.+)$/m)[1],
        version = block.match(/^Version: (.+)$/m)[1];
      const source = (block.match(/^Source: (.+)$/m)?.[1] ?? name).match(
        /^(\S+)(?: \(([^)]+)\))?$/,
      );
      if (!source) throw Error('Invalid source package metadata');
      selected.add('/usr/share/doc/' + name + '/copyright');
      return {
        name,
        version,
        sourceName: source[1],
        sourceVersion: source[2] ?? version,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const directory of [
    'app',
    'tmp',
    'opt',
    'home/node',
    'root',
    'run/lab',
    'etc',
    'var/lib/dpkg',
  ])
    mkdirSync(join(root, directory), { recursive: true });
  chmodSync(join(root, 'tmp'), 0o1777);
  const files = [];
  for (const path of [...selected].sort()) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
    chmodSync(target, statSync(path).mode & 0o777);
    files.push({
      path,
      sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
    });
  }
  writeFileSync(
    join(root, 'etc/passwd'),
    'root:x:0:0:root:/root:/sbin/nologin\nnode:x:1000:1000:node:/home/node:/sbin/nologin\n',
  );
  writeFileSync(join(root, 'etc/group'), 'root:x:0:\nnode:x:1000:\n');
  writeFileSync(
    join(root, 'etc/nsswitch.conf'),
    'passwd: files\ngroup: files\nhosts: files dns\n',
  );
  writeFileSync(join(root, 'var/lib/dpkg/status'), status.join('\n\n') + '\n');
  writeFileSync(
    join(root, 'app/runtime-inventory.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        profile: 'filtered-node-glibc-v1',
        sourceImage,
        architecture: process.arch === 'x64' ? 'amd64' : 'arm64',
        nodeVersions: process.versions,
        osPackages,
        files,
      },
      null,
      2,
    ) + '\n',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, dockerfile, ...extra] = process.argv.slice(2);
  if (!root || !dockerfile || extra.length)
    throw Error('Expected output root and source Dockerfile');
  prepare(root, dockerfile);
}
