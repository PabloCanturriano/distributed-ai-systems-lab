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
