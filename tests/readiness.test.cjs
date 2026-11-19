const { createApi } = require('../apps/api/dist/app.js');

test('readiness reflects dependency state while liveness stays independent', async () => {
  let ready = true;
  const probe = { isReady: async () => ready };
  const app = await createApi(probe);
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const response = await fetch(`${url}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
    ready = false;
    const degraded = await fetch(`${url}/health/ready`);
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toEqual({ status: 'not_ready' });
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    ready = true;
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
  } finally {
    await app.close();
  }
});

test('readiness errors never expose dependency exception content', async () => {
  const app = await createApi({
    isReady: async () => {
      throw new Error('fictional-sensitive-connection-value');
    },
  });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  } finally {
    await app.close();
  }
});
