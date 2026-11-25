const {
  refreshOperationalMetrics,
} = require('../apps/worker/dist/operational-metrics');
test('the snapshot is published only after a committed read-only transaction', async () => {
  const snapshot = jest.fn();
  const client = {
    query: jest.fn(async (sql) => {
      if (sql.startsWith('SELECT'))
        return { rows: [{ metric: 'jobs', dimension: 'queued', value: 3 }] };
      if (sql === 'COMMIT') expect(snapshot).not.toHaveBeenCalled();
      return {};
    }),
    release: jest.fn(),
  };
  await refreshOperationalMetrics(
    { connect: async () => client },
    { snapshot },
  );
  expect(client.query.mock.calls[0][0]).toBe('BEGIN READ ONLY');
  expect(snapshot).toHaveBeenCalledWith([
    { metric: 'jobs', dimension: 'queued', value: 3 },
  ]);
  expect(client.release).toHaveBeenCalledWith(false);
});
test('a failed snapshot retains the previous sample and releases the connection', async () => {
  const snapshot = jest.fn(),
    client = {
      query: jest.fn(async (sql) => {
        if (sql.startsWith('SELECT')) throw Error('private-db-error');
      }),
      release: jest.fn(),
    };
  await expect(
    refreshOperationalMetrics({ connect: async () => client }, { snapshot }),
  ).rejects.toThrow();
  expect(snapshot).not.toHaveBeenCalled();
  expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  expect(client.release).toHaveBeenCalledWith(true);
});
