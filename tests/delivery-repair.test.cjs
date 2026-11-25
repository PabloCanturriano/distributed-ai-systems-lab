const { DeliveryRepairs } = require('../apps/operations/dist/delivery-repairs');
test('invalid repair expectations never connect or mutate SQL', async () => {
  const pool = { connect: jest.fn() };
  await expect(new DeliveryRepairs(pool).repair({})).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  expect(pool.connect).not.toHaveBeenCalled();
});
