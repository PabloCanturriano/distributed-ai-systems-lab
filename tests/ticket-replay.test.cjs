const { randomUUID } = require('node:crypto');
const { TicketReplays } = require('../apps/api/dist/ticket-replay');
test('invalid replay input never reaches SQL', async () => {
  const pool = { connect: jest.fn() };
  await expect(
    new TicketReplays(pool).replay({ expectedGeneration: 0 }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(pool.connect).not.toHaveBeenCalled();
});
const valid = () => ({
  tenantId: randomUUID(),
  principalId: randomUUID(),
  ticketId: randomUUID(),
  requestId: randomUUID(),
  key: 'stable-key',
  body: { expectedGeneration: 1 },
});
test.each([0, -1, 1.1, 2147483647, '1', null])(
  'invalid expected generation %s never reaches SQL',
  async (expectedGeneration) => {
    const pool = { connect: jest.fn() };
    await expect(
      new TicketReplays(pool).replay({
        ...valid(),
        body: { expectedGeneration },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(pool.connect).not.toHaveBeenCalled();
  },
);
test('caller-selected tenant overrides or extra body fields are rejected', async () => {
  const pool = { connect: jest.fn() };
  await expect(
    new TicketReplays(pool).replay({
      ...valid(),
      body: { expectedGeneration: 1, tenantId: randomUUID() },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(pool.connect).not.toHaveBeenCalled();
});
test('connection failures stay generic', async () => {
  const pool = {
    connect: async () => {
      throw new Error('private SQL credentials');
    },
  };
  await expect(new TicketReplays(pool).replay(valid())).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'DEPENDENCY_UNAVAILABLE',
  });
});
