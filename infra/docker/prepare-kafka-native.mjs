// Explicit, checksum-pinned build step. npm lifecycle hooks remain disabled.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

assert.equal(process.platform, 'linux');
assert.equal(process.versions.modules, '137');
const digests = {
  arm64: '8ce2595cfe62bae5fafd206ed78d1d8a8188e2019534b063f51710a8e7798384',
  x64: '56b443c9339cb0ae423588599af1df7636eb426c1ac93bf54906e52a0ee77699',
};
const digest = digests[process.arch];
assert.ok(digest, 'Unreviewed native architecture');
const root = 'node_modules/@confluentinc/kafka-javascript';
assert.equal(
  JSON.parse(await readFile(`${root}/package.json`, 'utf8')).version,
  '1.11.0',
);
const url = `https://github.com/confluentinc/confluent-kafka-javascript/releases/download/v1.11.0/confluent-kafka-javascript-v1.11.0-node-v137-linux-glibc-${process.arch}.tar.gz`;
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
assert.ok(response.ok, 'Official native artifact unavailable');
const archive = Buffer.from(await response.arrayBuffer());
assert.equal(createHash('sha256').update(archive).digest('hex'), digest);
await mkdir(`${root}/build`, { recursive: true });
await writeFile('/tmp/kafka-native.tar.gz', archive);
try {
  execFileSync('tar', [
    '-xzf',
    '/tmp/kafka-native.tar.gz',
    '-C',
    `${root}/build`,
    'Release/confluent-kafka-javascript.node',
  ]);
} finally {
  await rm('/tmp/kafka-native.tar.gz');
}
console.log(
  JSON.stringify({
    event: 'native_artifact_verified',
    architecture: process.arch,
    sha256: digest,
  }),
);
