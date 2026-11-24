import { runCli } from './cli';
import { readCredential } from './credentials';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
void runCli(process.argv.slice(2), {
  credential: readCredential,
  signal: controller.signal,
  progress: (status) => process.stderr.write(`Ticket ${status}.\n`),
})
  .then((result) => {
    process.stdout.write(
      JSON.stringify(result.output, null, result.json ? undefined : 2) + '\n',
    );
    process.exitCode = result.exitCode;
  })
  .catch(() => {
    process.stdout.write(
      '{"schemaVersion":1,"command":"unknown","outcome":"error","elapsedMs":0,"error":{"code":"INTERNAL_ERROR","message":"CLI failed."}}\n',
    );
    process.exitCode = 4;
  });
