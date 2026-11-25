// Trusted disposable evaluation actor; never copied into application images.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire('/app/apps/worker/package.json');
const { Pool } = require('pg');
const { KnowledgeRetrieval } = require('./dist/knowledge-retrieval');
const input = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(input.profile, 'lexical-hash-v1');
assert.equal(input.cases.length, 30);
const pool = new Pool({
  host: 'postgres',
  database: 'lab',
  user: 'lab_worker_login',
  password: readFileSync('/run/lab/worker/password', 'utf8'),
  max: 1,
  connectionTimeoutMillis: 1000,
  query_timeout: 5000,
});
pool.on('error', () => {});
const store = new KnowledgeRetrieval(pool),
  cases = [];
try {
  for (const c of input.cases) {
    const start = performance.now();
    const evidence = await store.search({
      tenantId: c.tenantId,
      snapshotId: c.snapshotId,
      profile: input.profile,
      policy: input.policy,
      query: c.query,
    });
    assert(evidence.length <= 5);
    for (const row of evidence) {
      assert.equal(row.tenantId, c.tenantId);
      assert.equal(row.snapshotId, c.snapshotId);
      assert(Buffer.byteLength(row.content) <= 2048);
    }
    const retrieved = evidence.map((x) => x.chunkId);
    const found = c.expectedChunks.filter((id) => retrieved.includes(id));
    cases.push({
      id: c.id,
      category: c.category,
      split: c.split,
      answerable: c.answerable,
      expectedChunks: c.expectedChunks,
      retrievedChunks: retrieved,
      recallAt5: c.answerable ? found.length / c.expectedChunks.length : null,
      elapsedMs: Math.round((performance.now() - start) * 1000) / 1000,
    });
  }
  console.log(JSON.stringify({ cases }));
} finally {
  await pool.end();
}
