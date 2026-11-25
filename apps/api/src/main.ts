import { localTelemetry } from '@lab/telemetry';
import { loadApiConfiguration } from '@lab/configuration';
import { createApi } from './app';
import { ApiDependencies } from './dependencies';

async function main(): Promise<void> {
  const configuration = loadApiConfiguration(process.env);
  const telemetry = localTelemetry('lab-api', 'api');
  const dependencies = configuration.dependencies
    ? await ApiDependencies.create(configuration.dependencies, telemetry)
    : undefined;
  const app = await createApi(
    dependencies,
    dependencies?.tickets,
    telemetry,
  ).catch(async (error: unknown) => {
    await dependencies?.onApplicationShutdown();
    await telemetry.shutdown();
    throw error;
  });
  app.enableShutdownHooks();
  try {
    await app.listen(configuration.port, configuration.host);
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log(JSON.stringify({ event: 'api_listening', ready: false }));
}

void main().catch(() => {
  console.error(JSON.stringify({ event: 'api_start_failed' }));
  process.exitCode = 1;
});
