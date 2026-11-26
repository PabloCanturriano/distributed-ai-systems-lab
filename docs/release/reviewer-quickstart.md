# Docker-only reviewer journey

Status: locally verified with the candidate source by `npm run test:quickstart` on 2026-11-25. Both tenant demos, duplicate receipt and queued-work recovery passed; owned resources were cleaned up. Application services and CLI run inside the pinned Docker images. The optional automated driver uses Node built-ins and Git on the host; the manual journey below requires Git and a working Docker Engine/Compose installation, not host application packages or compiled output.

Run from a fresh checkout using fictional data. The default API publication is loopback port 3000. Set `LAB_API_PORT` to another free loopback port if needed.

```sh
docker compose build cli
docker compose --profile messaging --profile execution up --build --detach --wait --wait-timeout 180
docker compose run --rm --no-deps -T cli demo --identity harbor.requester --json
docker compose run --rm --no-deps -T cli demo --identity summit.requester --json
```

Both demos should complete with simulated cited answers, tenant-owned references and a bounded execution summary. The fixed offline workflow invokes documentation search, ticket lifecycle lookup and fictional service status. These outputs do not establish real-model semantic quality or live service health.

## Duplicate receipt

Run the same command twice with one unused operation key:

```sh
docker compose run --rm --no-deps -T cli ticket create --message 'retry policy' --key reviewer-duplicate-1 --identity harbor.requester --json
docker compose run --rm --no-deps -T cli ticket create --message 'retry policy' --key reviewer-duplicate-1 --identity harbor.requester --json
```

The returned `ticket` receipt must be identical. The key is retained for the ticket lifetime; use a new key for another intended operation. `elapsedMs` and tracing metadata can differ.

## Queued-work recovery

```sh
docker compose --profile execution stop executor
docker compose run --rm --no-deps -T cli ticket create --message 'retry policy' --key reviewer-recovery-1 --identity harbor.requester --json
```

Copy the returned ticket ID, then read it while the executor is stopped:

```sh
docker compose run --rm --no-deps -T cli ticket get <ticket-id> --identity harbor.reader --json
docker compose --profile execution start executor
docker compose run --rm --no-deps -T cli ticket wait <ticket-id> --identity harbor.reader --deadline 60 --json
```

The ticket is queued before restart and completes afterward without manually scheduling or completing a job. Detailed broker/process crash, real lease-expiry, quarantine/repair and replay scenarios remain in the [operations guides](../README.md) and the phase-five gate.

Stop the demo while preserving data with:

```sh
docker compose --profile messaging --profile execution down
```

Removing volumes is an explicit reset that invalidates demo identities and removes demo history. The automated quickstart uses its own unique Compose project and deletes only that project's volumes/images during cleanup.

## Reproducible measurement

`npm run test:quickstart` builds an isolated Git-tree archive of candidate source with no `.git`, `node_modules` or host build outputs. A temporary Git index leaves the owner's index untouched; a unit test verifies staged/unstaged content and ignored credential/cache exclusion. The driver uses only Docker commands inside that archive for application preparation and business operations.

The sanitized report is `artifacts/reviewer-quickstart-report.json`. It identifies base revision, candidate tree, implementation digest, engine/Compose/controller versions, CLI-build and stack-start durations, own-container resource samples, assertions and cleanup. Existing Docker build cache may be used. Resource observations are checkpoint samples, not peak measurements or supported minimum hardware requirements. Source changes during the run or failed cleanup make the report fail.

### Recorded candidate observation

The final candidate report identifies implementation digest `f5aebca27b0db2dd435180d55ad1e9c6d27a7cb7e7ff16e24c70525eb462bda2`. The observed Docker Engine was 29.2.1, Compose 5.1.0, Linux/aarch64, with ten configured Docker CPUs and 8,217,059,328 assigned memory bytes. The controller used Node 24.22.3 on Darwin/arm64.

With existing build cache, CLI build took 608 ms, stack startup took 20,508 ms, and build plus startup took 21,116 ms. Four resource checkpoints were captured. These are observations on that environment with fresh project volumes, not cold-cache timings, peak usage or supported minimum requirements.

## OpenAPI from the image

After the application images are built, export the implemented HTTP contract without installing host application packages:

```sh
mkdir -p artifacts
docker compose run --rm --no-deps -T api node -e 'console.log(JSON.stringify(require("./apps/api/dist/openapi").createOpenApiDocument(), null, 2))' > artifacts/openapi-v1.json
```

This image-built export was checked byte-for-byte against the host exporter, for all five documented operations. It does not start a public documentation endpoint.
