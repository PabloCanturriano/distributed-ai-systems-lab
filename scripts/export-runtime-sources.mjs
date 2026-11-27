import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function sourceChecksums(dsc) {
  const section = dsc.match(/^Checksums-Sha256:\n((?: .+\n)+)/m)?.[1];
  if (!section) throw Error('Source descriptor lacks SHA256 checksums');
  return Object.fromEntries(
    section
      .trim()
      .split('\n')
      .map((line) => {
        const match = line
          .trim()
          .match(/^([a-f0-9]{64})\s+(\d+)\s+([A-Za-z0-9][A-Za-z0-9.+~_-]*)$/);
        if (!match) throw Error('Invalid source descriptor entry');
        return [match[3], { sha256: match[1], size: Number(match[2]) }];
      }),
  );
}

async function download(inventory, output) {
  const root = resolve(output);
  mkdirSync(root, { recursive: true });
  const packages = [
    ...new Map(
      inventory.osPackages.map((x) => [
        x.sourceName + '@' + x.sourceVersion,
        { name: x.sourceName, version: x.sourceVersion },
      ]),
    ).values(),
  ];
  const manifests = [];
  async function get(url, json = false) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok)
      throw Error('Corresponding source unavailable: ' + response.status);
    return json ? response.json() : Buffer.from(await response.arrayBuffer());
  }
  for (const item of packages) {
    if (
      !/^[a-z0-9][a-z0-9+.-]*$/.test(item.name) ||
      !/^[-A-Za-z0-9.+~:]+$/.test(item.version)
    )
      throw Error('Invalid source package identity');
    const metadata = await get(
      `https://snapshot.debian.org/mr/package/${item.name}/${encodeURIComponent(item.version)}/srcfiles`,
      true,
    );
    if (
      metadata.package !== item.name ||
      metadata.version !== item.version ||
      !metadata.result?.length
    )
      throw Error('Source package identity mismatch');
    const folder = join(root, item.name + '_' + item.version);
    mkdirSync(folder, { recursive: true });
    const files = [];
    for (const entry of metadata.result) {
      if (!/^[a-f0-9]{40}$/.test(entry.hash))
        throw Error('Invalid snapshot identity');
      const info = await get(
        `https://snapshot.debian.org/mr/file/${entry.hash}/info`,
        true,
      );
      const record = info.result?.find((x) =>
        /^[A-Za-z0-9][A-Za-z0-9.+~_-]*$/.test(x.name),
      );
      if (!record) throw Error('Missing safe source filename');
      const url = `https://snapshot.debian.org/file/${entry.hash}`;
      const bytes = await get(url);
      if (
        bytes.length !== record.size ||
        createHash('sha1').update(bytes).digest('hex') !== entry.hash
      )
        throw Error('Snapshot source integrity mismatch');
      writeFileSync(join(folder, record.name), bytes);
      files.push({
        name: record.name,
        url,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
    }
    const descriptor = files.find((x) => x.name.endsWith('.dsc'));
    if (!descriptor) throw Error('Missing source descriptor');
    const expected = sourceChecksums(
      readFileSync(join(folder, descriptor.name), 'utf8'),
    );
    for (const [name, value] of Object.entries(expected)) {
      const actual = files.find((x) => x.name === name);
      if (
        !actual ||
        actual.sha256 !== value.sha256 ||
        actual.size !== value.size
      )
        throw Error('Source descriptor checksum mismatch');
    }
    if (files.some((x) => x !== descriptor && !expected[x.name]))
      throw Error('Unlisted source archive');
    manifests.push({ ...item, descriptor: descriptor.name, files });
    console.log(
      JSON.stringify({
        event: 'corresponding_source_verified',
        ...item,
        files: files.length,
      }),
    );
  }
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceImage: inventory.sourceImage,
        architecture: inventory.architecture,
        packages: manifests,
      },
      null,
      2,
    ) + '\n',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length)
    throw Error('Expected runtime inventory and output directory');
  await download(JSON.parse(readFileSync(input, 'utf8')), output);
}
