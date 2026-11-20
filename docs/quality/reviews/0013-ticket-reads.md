# Tenant-scoped ticket status reads

Status: prepared for exact-patch review; not committed or pushed. Base `2dade27` is the approved HTTP submission commit. This slice makes its receipt statusUrl usable for current queued/processing tickets. No dependency, schema, privilege or runtime configuration changes.

Proposed commit: `feat: add tenant-scoped ticket status reads`.

## Patch

- `apps/api/src/ticket-read.ts`: validates IDs, rechecks active same-tenant membership, and performs an explicit read-only transaction using the API role. One tenant-scoped join resolves the current generation and returns only ticket ID, generation, status, UTC timestamps and null result/failure. Missing and foreign tickets share NOT_FOUND. No ticket message, principal identity, event metadata or raw errors are returned.
- `apps/api/src/ticket-access.ts`, `ticket-http.ts`: GET controller, shared authentication/header/error handling with POST, and the existing 120-per-principal minute budget. Reads also use the peer ingress budget, but do not consume the tenant's submission quota. Authentication still runs on every attempt. No caller-selected tenant is accepted.
- `tests/ticket-http.test.cjs`, `tests/database/ticket-submission.test.cjs`, `scripts/ticket-http-scenario.mjs`: HTTP contracts, PostgreSQL current-generation/membership cases and the real Compose create/read flow. Documentation status and this evidence report are updated.

## Verification on 2026-11-20

Red: the initial real HTTP read test expected 200 and received 404. After implementation, `npm run check` passed formatting, workspace builds/type checks and **73 fast tests**. `npm run test:database` passed **77 real PostgreSQL tests**. New assertions cover exact queued output, foreign/missing identity equivalence, invalid IDs, disabled/wrong-tenant principals and current-generation selection. A migrator-only generation-2/processing fixture verifies pointer handling without claiming a replay/executor implementation. Existing submission rollback/idempotency and credential tests remain green.

`npm run test:compose` passed create-then-follow-Location with real generated credentials for all three roles. A foreign tenant and a missing UUID produce identical 404 errors apart from fresh request IDs, even with a forged tenant header. Reads stay available after the tenant's creation quota is exhausted, honor the shared principal quota, and reject revoked credentials. Both stop and pause outages for PostgreSQL/Redis produce safe 503 for GET and POST; recovery, persistence, scoped mounts, secret-log checks and initialization failure gates remain green.

`npm run test:containers` also passed API/worker builds, startup, isolation, safe failure and shutdown. Final formatting, JavaScript syntax, relative documentation links and whitespace checks passed. Execution uses the existing Node 24.22.3, PostgreSQL 17.12/pgvector 0.8.7 and Redis 8.10.3 pins on macOS arm64/Docker Linux arm64. Other platforms and hosted CI are not verified by this local patch. No new dependency or image-security scan ran.

## Limits

The current writer only creates queued tickets; no worker is executing them. Processing reads are verified with a controlled SQL fixture. Completed/failed result storage is not implemented: terminal rows manually introduced by an operator return generic 503 rather than fabricated success/failure output. Two negative database cases verify that guard. Full terminal reads must arrive with actual result/failure persistence before an executor can expose those states normally.

This adds selected read/tenant-isolation portions of HTTP-05 and SEC-03/04; replay, full HTTP-04 completion, AI output, event admission/publication and complete recovery acceptance remain future work. Reads expose all tickets within the authenticated tenant as specified, not individual creator-only visibility. The transaction uses caller-owned bounded pool settings and does not cache identity or ticket state.
