import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
if (process.argv.length !== 2) throw Error('No export arguments are supported');
const { createOpenApiDocument } = require('../apps/api/dist/openapi');
mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/openapi-v1.json',
  JSON.stringify(createOpenApiDocument(), null, 2) + '\n',
);
console.log(
  JSON.stringify({
    event: 'openapi_exported',
    path: 'artifacts/openapi-v1.json',
    version: '3.1.1',
    operations: 5,
  }),
);
