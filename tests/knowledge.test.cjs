const {
  lexicalVector,
  chunksFor,
  sha256,
  retrievalCacheKey,
  validateEvidenceResult,
} = require('../packages/knowledge/dist');
const tenant = 'a1000000-0000-4000-8000-000000000001';
const document = 'b1000000-0000-4000-8000-000000000001';
test('lexical-hash-v1 uses SHA256 big-endian coordinates, counts and unit length', () => {
  const { createHash } = require('node:crypto');
  const a = createHash('sha256').update('alpha').digest().readUInt32BE(0) % 128;
  const b = createHash('sha256').update('beta').digest().readUInt32BE(0) % 128;
  const v = lexicalVector('ALPHA alpha beta');
  expect(v).toHaveLength(128);
  expect(v[a]).toBeCloseTo(2 / Math.sqrt(5));
  expect(v[b]).toBeCloseTo(1 / Math.sqrt(5));
  expect(v.reduce((sum, n) => sum + n * n, 0)).toBeCloseTo(1);
  expect(lexicalVector('中文 🌊')).toBeNull();
});
test('chunking normalizes LF deterministically and splits multibyte paragraphs without corruption', () => {
  const body = '🌊'.repeat(1300) + '\r\n\r\nTail paragraph';
  const a = chunksFor(document, 'v1', body),
    b = chunksFor(document, 'v1', body.replaceAll('\r\n', '\n'));
  expect(a).toEqual(b);
  expect(a.length).toBeGreaterThan(2);
  for (const chunk of a) {
    expect(Buffer.byteLength(chunk.content)).toBeLessThanOrEqual(2048);
    expect(chunk.content).not.toContain('\ufffd');
    expect(chunk.digest).toBe(sha256(chunk.content));
  }
  expect(new Set(a.map((x) => x.id)).size).toBe(a.length);
  expect(chunksFor(document, 'v2', body)[0].id).not.toBe(a[0].id);
});
test('cache identity includes tenant, snapshot, profile, query and policy independently', () => {
  const base = {
    tenantId: tenant,
    snapshotId: document,
    profile: 'lexical-hash-v1',
    policy: 'extractive-simulated-v1',
    query: 'Recovery',
  };
  for (const [key, value] of Object.entries({
    tenantId: document,
    snapshotId: tenant,
    profile: 'other',
    policy: 'other',
    query: 'Other',
  }))
    expect(retrievalCacheKey({ ...base, [key]: value })).not.toBe(
      retrievalCacheKey(base),
    );
});
test('only delivered evidence in the pinned tenant/snapshot may support an answered result', () => {
  const evidence = {
    tenantId: tenant,
    snapshotId: document,
    documentId: document,
    documentVersion: 'v1',
    chunkId: tenant,
    content: 'Fictional evidence',
    score: 1,
  };
  const context = {
    tenantId: tenant,
    snapshotId: document,
    evidence: [evidence],
  };
  const result = {
    outcome: 'answered',
    answer: 'Fictional evidence',
    citations: [
      { documentId: document, documentVersion: 'v1', chunkId: tenant },
    ],
  };
  expect(validateEvidenceResult(result, context).outcome).toBe('answered');
  expect(() =>
    validateEvidenceResult({ ...result, citations: [] }, context),
  ).toThrow();
  expect(() =>
    validateEvidenceResult(result, { ...context, tenantId: document }),
  ).toThrow();
  expect(() =>
    validateEvidenceResult(
      { ...result, citations: [{ ...result.citations[0], chunkId: document }] },
      context,
    ),
  ).toThrow();
  expect(() =>
    validateEvidenceResult(
      { ...result, outcome: 'insufficient_evidence' },
      context,
    ),
  ).toThrow();
});
test('custom SHA256 chunk identity uses UUID version 8', () => {
  const { stableId } = require('../packages/knowledge/dist');
  expect(stableId('chunk identity').split('-')[2][0]).toBe('8');
});
