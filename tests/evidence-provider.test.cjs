const { scriptedAnswer } = require('../apps/worker/dist/evidence-provider');
const evidence = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  snapshotId: 'c1000000-0000-4000-8000-000000000001',
  documentId: 'b1000000-0000-4000-8000-000000000001',
  documentVersion: 'v1',
  chunkId: 'd1000000-0000-4000-8000-000000000001',
  content:
    'Harbor retry policy permits three attempts with exponential jitter.',
  score: 0.8,
};
test('scripted extractive mode cites only an excerpt actually retrieved for the question', () => {
  const r = scriptedAnswer('retry exponential jitter', [evidence]);
  expect(r.outcome).toBe('answered');
  expect(r.answer).toContain(evidence.content);
  expect(r.citations).toEqual([
    {
      documentId: evidence.documentId,
      documentVersion: 'v1',
      chunkId: evidence.chunkId,
    },
  ]);
});
test('zero or weak lexical evidence abstains without citing unrelated text', () => {
  for (const values of [[], [evidence]]) {
    const r = scriptedAnswer('orbital telescope aperture', values);
    expect(r.outcome).toBe('insufficient_evidence');
    expect(r.citations).toEqual([]);
  }
});
