import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DeliveryRepairs, RepairError } from './delivery-repairs';
async function main() {
  if (
    process.env.APP_MODE !== 'local' ||
    process.argv.length !== 3 ||
    !['inspect', 'plan', 'repair'].includes(process.argv[2]!)
  )
    throw new RepairError('INVALID_REQUEST');
  const f = await open(
    '/run/lab/operations/password',
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let password: string;
  try {
    const s = await f.stat();
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o777) !== 0o600 ||
      s.size !== 43
    )
      throw new Error();
    password = await f.readFile('utf8');
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(password) ||
      Buffer.from(password, 'base64url').toString('base64url') !== password
    )
      throw new Error();
  } finally {
    await f.close();
  }
  const pool = new Pool({
    host: 'postgres',
    port: 5432,
    database: 'lab',
    user: 'lab_operations_login',
    password,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 1000,
    query_timeout: 6000,
    statement_timeout: 5000,
    idleTimeoutMillis: 1000,
    application_name: 'lab-operations',
  });
  pool.on('error', () => {});
  try {
    const store = new DeliveryRepairs(pool),
      action = process.argv[2]!;
    let result: unknown;
    if (action === 'inspect') result = await store.inspect();
    else {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 8192) throw new RepairError('INVALID_REQUEST');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      let input: unknown;
      try {
        input = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new RepairError('INVALID_REQUEST');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new RepairError('INVALID_REQUEST');
      const request = { ...input, requestId: randomUUID() };
      result =
        action === 'plan'
          ? await store.plan(request)
          : await store.repair(request);
    }
    console.log(JSON.stringify({ schemaVersion: 1, action, result }));
  } finally {
    await pool.end();
  }
}
void main().catch((error) => {
  const code =
    error instanceof RepairError ? error.code : 'DEPENDENCY_UNAVAILABLE';
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      error: { code, message: 'Operational command did not complete.' },
    }),
  );
  process.exitCode =
    code === 'INVALID_REQUEST' ? 2 : code === 'DEPENDENCY_UNAVAILABLE' ? 4 : 3;
});
