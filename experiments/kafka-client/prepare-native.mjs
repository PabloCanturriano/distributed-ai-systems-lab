// Test-only artifact preparation. No npm lifecycle hook or source-build fallback.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

assert.equal(process.platform, 'linux');
assert.equal(
  process.arch,
  'arm64',
  'only the reviewed arm64 artifact is allowed',
);
assert.equal(process.versions.modules, '137');
const digest =
  '8ce2595cfe62bae5fafd206ed78d1d8a8188e2019534b063f51710a8e7798384';
const url =
  'https://github.com/confluentinc/confluent-kafka-javascript/releases/download/v1.11.0/confluent-kafka-javascript-v1.11.0-node-v137-linux-glibc-arm64.tar.gz';
const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
assert.equal(response.ok, true, 'official native artifact download failed');
const archive = Buffer.from(await response.arrayBuffer());
assert.equal(createHash('sha256').update(archive).digest('hex'), digest);
await mkdir('node_modules/@confluentinc/kafka-javascript/build', {
  recursive: true,
});
await writeFile('/tmp/kafka-native.tar.gz', archive);
// Extract just the addon, excluding vendor object files/build metadata.
execFileSync('tar', [
  '-xzf',
  '/tmp/kafka-native.tar.gz',
  '-C',
  'node_modules/@confluentinc/kafka-javascript/build',
  'Release/confluent-kafka-javascript.node',
]);
await rm('/tmp/kafka-native.tar.gz');
console.log(
  JSON.stringify({ event: 'native_artifact_verified', sha256: digest }),
);
