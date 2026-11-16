import { loadApiConfiguration } from '@lab/configuration';
import { createApi } from './app';

async function main(): Promise<void> {
  const configuration = loadApiConfiguration(process.env);
  const app = await createApi();
  app.enableShutdownHooks();
  await app.listen(configuration.port, configuration.host);
  console.log(JSON.stringify({ event: 'api_listening', ready: false }));
}

void main().catch(() => {
  console.error(JSON.stringify({ event: 'api_start_failed' }));
  process.exitCode = 1;
});
