const { randomUUID } = require('node:crypto');
const {
  ExecutionOwnership,
} = require('../apps/worker/dist/execution-ownership.js');
test.each(['renew', 'retry', 'fail'])(
  'invalid ownership identities for %s never reach SQL',
  (operation) => {
    const pool = { connect: jest.fn() };
    let failure;
    try {
      new ExecutionOwnership(pool)[operation](
        'fictional-private-invalid-id',
        randomUUID(),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'INVALID_REQUEST',
    });
    expect(failure.cause).toBeUndefined();
    expect(pool.connect).not.toHaveBeenCalled();
  },
);
test('ownership connection errors remain generic', async () => {
  const pool = {
    connect: jest
      .fn()
      .mockRejectedValue(new Error('fictional-private-database-detail')),
  };
  await expect(new ExecutionOwnership(pool).claim()).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'DEPENDENCY_UNAVAILABLE',
  });
});
test.each([
  { outcome: 'answered', answer: 'Unsupported answer' },
  { outcome: 'insufficient_evidence', answer: '' },
  { outcome: 'insufficient_evidence', answer: ' \n\t ' },
  { outcome: 'insufficient_evidence', answer: 'x'.repeat(8193) },
  { outcome: 'insufficient_evidence', answer: '🙂'.repeat(2049) },
  { outcome: 'insufficient_evidence', answer: 'bad\0value' },
  { outcome: 'insufficient_evidence', answer: 'bad\ud800value' },
  {
    outcome: 'insufficient_evidence',
    answer: 'A simulation',
    providerMode: 'real',
  },
  {
    outcome: 'insufficient_evidence',
    answer: 'A simulation',
    citations: [{ documentId: randomUUID() }],
  },
])('unsupported or unsafe result content never reaches SQL', (input) => {
  const pool = { connect: jest.fn() };
  expect(() =>
    new ExecutionOwnership(pool).complete(randomUUID(), randomUUID(), input),
  ).toThrow('INVALID_REQUEST');
  expect(pool.connect).not.toHaveBeenCalled();
});
