import { createApi } from './app';

async function main(): Promise<void> {
  const app = await createApi();
  app.enableShutdownHooks();
  await app.listen(3000, '127.0.0.1');
  console.log(JSON.stringify({ event: 'api_listening', ready: false }));
}

void main().catch(() => {
  console.error(JSON.stringify({ event: 'api_start_failed' }));
  process.exitCode = 1;
});
