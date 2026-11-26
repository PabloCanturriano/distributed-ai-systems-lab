import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const [image, output, ...extra] = process.argv.slice(2);
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '') || !output || extra.length)
  throw Error(
    'Usage: node scripts/export-image-notices.mjs <local-image-sha256-id> <output-directory>',
  );
const destination = resolve(output);
if (existsSync(destination) && readdirSync(destination).length)
  throw Error('Notice output directory must be empty');
mkdirSync(join(destination, 'texts'), { recursive: true });
const source = readFileSync(new URL('./image-notices.mjs', import.meta.url));
const result = JSON.parse(
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-i',
      '--entrypoint',
      'node',
      image,
      '--input-type=module',
      '-',
    ],
    { input: source, maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
  ),
);
for (const file of result.files) {
  const content = Buffer.from(file.contentBase64, 'base64');
  if (
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    createHash('sha256').update(content).digest('hex') !== file.sha256
  )
    throw Error('Notice integrity mismatch');
  writeFileSync(join(destination, 'texts', file.sha256), content);
  delete file.contentBase64;
}
const manifest = { image, ...result };
writeFileSync(
  join(destination, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    event: 'image_notices_exported',
    image,
    packages: result.packages.length,
    files: result.files.length,
    missingLicenseText: result.packages.filter((x) => x.missingLicenseText)
      .length,
    skippedLinks: result.skippedLinks.length,
  }),
);
