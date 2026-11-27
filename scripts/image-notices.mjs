import {
  readdirSync,
  readFileSync,
  existsSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Read only installed artifacts. Never fetch or infer missing license texts.
export function collectImageNotices({
  modules = '/app/node_modules',
  osDocs = '/usr/share/doc',
  baseFiles = ['/usr/local/LICENSE', '/app/LICENSE', '/app/NOTICE'],
  licenseSupplements = [
    {
      name: 'tr46',
      version: '0.0.3',
      file: '/app/third-party/licenses/tr46-MIT.txt',
    },
    {
      name: '@redis/client',
      version: '6.3.1',
      file: '/app/third-party/licenses/redis-client-MIT.txt',
    },
  ],
} = {}) {
  const files = new Map(),
    packages = [],
    skippedLinks = [];
  const legalName =
    /^(?:licen[cs]es?|copying|copyright|notices?|authors)(?:[._-].*)?$/i;
  function capture(path, boundary) {
    const actual = realpathSync(path),
      root = realpathSync(resolve(boundary));
    if (actual !== root && !actual.startsWith(root + sep)) {
      skippedLinks.push(path);
      return false;
    }
    const content = readFileSync(path);
    files.set(path, {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      contentBase64: content.toString('base64'),
    });
    return true;
  }
  function legalFiles(directory, boundary, recursive = false) {
    const found = [];
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && recursive)
        found.push(...legalFiles(path, boundary, true));
      else if (
        !entry.isDirectory() &&
        legalName.test(entry.name) &&
        capture(path, boundary)
      )
        found.push(path);
    }
    return found;
  }
  function visitModules(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        visitModules(path);
        continue;
      }
      const manifest = join(path, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const notices = legalFiles(path, path);
      if (!notices.length) {
        for (const name of readdirSync(path).filter((name) =>
          /^readme(?:\.|$)/i.test(name),
        )) {
          const readme = join(path, name);
          if (!lstatSync(readme).isFile()) continue;
          const text = readFileSync(readme, 'utf8');
          if (
            /copyright/i.test(text) &&
            /permission is hereby granted/i.test(text) &&
            capture(readme, path)
          )
            notices.push(readme);
        }
      }
      if (pkg.name === '@confluentinc/kafka-javascript') {
        const native = join(path, 'deps/librdkafka');
        if (existsSync(native)) notices.push(...legalFiles(native, path, true));
      }
      for (const supplement of licenseSupplements) {
        if (
          !notices.length &&
          pkg.name === supplement.name &&
          pkg.version === supplement.version &&
          existsSync(supplement.file) &&
          capture(supplement.file, supplement.file)
        )
          notices.push(supplement.file);
      }
      packages.push({
        name: pkg.name,
        version: pkg.version,
        declaredLicense: pkg.license ?? pkg.licenses ?? null,
        path,
        files: notices,
        missingLicenseText: notices.length === 0,
      });
      visitModules(join(path, 'node_modules'));
    }
  }
  visitModules(modules);
  if (modules === '/app/node_modules')
    visitModules('/usr/local/lib/node_modules');
  if (osDocs && existsSync(osDocs)) legalFiles(osDocs, osDocs, true);
  if (osDocs && existsSync('/usr/share/common-licenses'))
    for (const name of readdirSync('/usr/share/common-licenses')) {
      const path = join('/usr/share/common-licenses', name);
      if (lstatSync(path).isFile()) capture(path, path);
    }
  if (osDocs && existsSync('/opt')) legalFiles('/opt', '/opt', true);
  if (existsSync('/app/third-party/licenses'))
    legalFiles('/app/third-party/licenses', '/app/third-party/licenses', true);
  for (const path of baseFiles)
    if (existsSync(path) && lstatSync(path).isFile()) capture(path, path);
  const runtimeInventory = existsSync('/app/runtime-inventory.json')
    ? JSON.parse(readFileSync('/app/runtime-inventory.json', 'utf8'))
    : null;
  if (runtimeInventory) {
    if (
      runtimeInventory.schemaVersion !== 1 ||
      runtimeInventory.profile !== 'filtered-node-glibc-v1' ||
      !Array.isArray(runtimeInventory.files)
    )
      throw Error('Unreviewed runtime inventory');
    for (const file of runtimeInventory.files)
      if (
        createHash('sha256').update(readFileSync(file.path)).digest('hex') !==
        file.sha256
      )
        throw Error('Runtime file identity mismatch');
  }
  const osPackages =
    runtimeInventory?.osPackages ??
    (osDocs
      ? execFileSync(
          'dpkg-query',
          [
            '-W',
            '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n',
          ],
          { encoding: 'utf8' },
        )
          .trim()
          .split('\n')
          .map((line) => {
            const [name, version, sourceName, sourceVersion] = line.split('\t');
            return { name, version, sourceName, sourceVersion };
          })
      : []);
  return {
    schemaVersion: 1,
    runtimeInventory,
    osPackages,
    packages,
    files: [...files.values()],
    skippedLinks,
  };
}

if (process.argv[1] === '-') console.log(JSON.stringify(collectImageNotices()));
