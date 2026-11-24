const { createServer } = require('node:http');
const { runCli } = require('../apps/cli/dist/cli');
const id = 'a3000000-0000-4000-8000-000000000001';
const credential = { lookupId: id, secret: 's'.repeat(43) };
const receipt = { ticketId: id, generation: 1, statusUrl: `/v1/tickets/${id}` };
async function server(handler, work) {
  const app = createServer(handler);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    return await work(
      (url, options) => fetch(base + new URL(url).pathname, options),
      base,
    );
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  }
}
test('real fetch does not forward credentials to a redirect target', async () => {
  let targetCalls = 0;
  await server(
    (req, res) => {
      targetCalls++;
      res.end('{}');
    },
    async (_, target) => {
      await server(
        (req, res) => {
          res.writeHead(307, { location: target });
          res.end();
        },
        async (fetch) => {
          const r = await runCli(['ticket', 'get', id], {
            credential: async () => credential,
            fetch,
          });
          expect(r.exitCode).toBe(4);
          expect(r.output.error.code).toBe('INVALID_RESPONSE');
          expect(targetCalls).toBe(0);
        },
      );
    },
  );
});
test('partial response loss retries a real POST with the original payload and key', async () => {
  const seen = [];
  await server(
    (req, res) => {
      const chunks = [];
      req.on('data', (x) => chunks.push(x));
      req.on('end', () => {
        seen.push({
          key: req.headers['idempotency-key'],
          body: Buffer.concat(chunks).toString(),
        });
        if (seen.length === 1) {
          res.writeHead(202, { 'content-length': '1000' });
          res.write('{');
          setImmediate(() => res.destroy());
        } else {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify(receipt));
        }
      });
    },
    async (fetch) => {
      const r = await runCli(
        ['ticket', 'create', '--message', 'fictional question'],
        { credential: async () => credential, fetch, key: () => 'same-key' },
      );
      expect(r.exitCode).toBe(0);
      expect(seen).toEqual([
        { key: 'same-key', body: '{"message":"fictional question"}' },
        { key: 'same-key', body: '{"message":"fictional question"}' },
      ]);
    },
  );
});
test('a real stalled body is cancelled by the overall deadline', async () => {
  await server(
    (req, res) => {
      res.writeHead(200);
      res.write('{');
    },
    async (fetch) => {
      const start = performance.now();
      const r = await runCli(['ticket', 'get', id, '--deadline', '1'], {
        credential: async () => credential,
        fetch,
      });
      expect(r.exitCode).toBe(5);
      expect(r.output.error.code).toBe('DEADLINE_EXCEEDED');
      expect(performance.now() - start).toBeLessThan(3000);
    },
  );
});
