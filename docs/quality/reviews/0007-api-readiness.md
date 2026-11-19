# PostgreSQL and Redis API readiness review

Status: prepared for exact-patch review; not committed or pushed. The preceding Compose patch was approved and committed as `e25b235`; that commit remains local without push.

## Purpose and behavior

The Compose stack previously initialized PostgreSQL but always returned API readiness 503. This slice connects the API under its dedicated database login, introduces minimal Redis infrastructure, and reports whether the current bootstrap/dependency prerequisites are usable.

The API mounts only its own PostgreSQL password read-only. It selects `lab_api` on each pooled checkout and queries a versioned metadata-only view; it cannot read the seed-manifest table directly. A forward migration exposes a contract version and an expected-fixture-ready boolean. Redis is internal, non-root, unpublished, memory-bounded, and disposable. Readiness requires both the expected PostgreSQL metadata and Redis PONG; liveness remains dependency-independent.

The disabled standalone mode preserves previous no-dependency startup and readiness 503. Compose explicitly enables local checks, so its API image healthcheck now waits for readiness. Worker behavior is unchanged and remains idle; no worker database/Redis client or readiness is fabricated. HTTP business routes, authentication, limiter/cache operations, Kafka, job processing, telemetry, and CI are not implemented here.

## Proposed commit and affected files

Proposed message: `feat: verify API readiness against PostgreSQL and Redis`.

- `apps/api/src/dependencies.ts`: scoped password-file reading, bounded PostgreSQL pool, explicit role selection, minimal Redis client, full PING deadline, shared concurrent probes, safe events, and shutdown.
- `apps/api/src/app.ts`: injectable internal readiness contract with exact generic 200/503 bodies and independent liveness.
- `apps/api/src/main.ts`: opt-in dependency wiring and startup-failure cleanup.
- `apps/api/package.json`, `package-lock.json`: explicit pg/type declarations already pinned elsewhere plus minimal official Redis client 6.3.1; existing package versions are not upgraded.
- `packages/configuration/src/index.ts`: validated API-only dependency mode, hosts, and ports; no password URL/env inputs.
- `database/migrations/1794873600000_api-readiness.cjs`: additive owner-defined readiness view with SELECT only for API; prior migrations unchanged.
- `compose.yaml`: pinned Redis, internal-only port, non-root bounded memory/no persistence, API's private read-only database secret, and dependency configuration/gating.
- `infra/docker/Dockerfile`: readiness healthcheck for enabled dependency mode; standalone mode still probes liveness.
- `scripts/compose-smoke.mjs`: real positive health, stop/start, pause/resume, restart identity, outage shutdown, scoped mounts, and both log streams checked for generated secret values.
- `tests/readiness.test.cjs`, `tests/configuration.test.cjs`, `tests/startup-configuration.test.cjs`: transport state/error contracts, dependency settings, and isolated standalone subprocess environments.
- `tests/database/foundation.test.cjs`: migration/history expectations, metadata-only API permissions, fixture/version checks, and upgrade from the seeded two-migration baseline preserving credentials/data.
- `README.md`, `docs/README.md`, `docs/roadmap.md`, `docs/architecture/security.md`, `docs/operations/local-environment.md`, `docs/operations/compose-foundation.md`, `docs/operations/container-images.md`, `docs/operations/api-readiness.md`, `docs/quality/testing.md`, and this review: implemented scope, command semantics, boundaries, and evidence.

The full patch includes new files and the lockfile. Unrelated `.idea/` files remain untouched and excluded. Commit approval does not authorize a push.

## Versions and image identity

Environment: macOS arm64, host Node 24.22.3/npm 10.2.4, Docker Desktop 29.2.1, Docker Compose v5.1.0, Linux arm64 containers. PostgreSQL remains 17.12 and pgvector 0.8.7. API pg/@types/pg remain 8.23.1; @redis/client is 6.3.1. The client requires Node >=20, compatible with the selected Node 24 runtime.

Redis server: `redis:8.10.3-trixie@sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53`. The digest was resolved against the official registry's multi-platform manifest. The initially requested bookworm variant did not exist; the published trixie variant was selected and tested. Other architectures/OS backends and OS-image security scanning remain unverified.

## Verification on 2026-11-17

Red: after successful compilation, the new readiness transport test supplied a positive dependency probe and expected 200; the existing API returned 503. The exception privacy case already passed. The implementation then made both transport cases pass.

Integration caught a second missing bound: an established Redis connection to a paused server left PING waiting beyond the HTTP test's 3-second limit. Inspecting the pinned client's actual queue code showed its SDK timeout listener removed at send time. An independent complete-command deadline now rejects the probe, resets the unresponsive connection, and reconnects without replaying the PING. The same pause/resume test then passed.

- `npm run check`: formatting, all four workspace type checks/builds, and 52 tests in 5 fast suites passed. Exact ready/unready response bodies and exception privacy are asserted through real loopback HTTP.
- `npm run test:database`: 28 real PostgreSQL tests passed. The view is false before seeding, true after valid seeding, and false for an incompatible fixture digest. API SELECT on the underlying seed-manifest table is denied. The initialized prior two-migration schema upgrades by exactly one migration with unchanged credential digest and an unrelated existing row preserved; repeat migration is a no-op.
- `npm run test:compose`: initialized stack reaches API readiness 200. Each Redis/PostgreSQL stop makes readiness 503 and liveness 200; restart restores readiness 200 without an API container/process restart. Pausing each server also produces a bounded safe 503 and recovers after unpause. The API exits normally or by SIGTERM (not SIGKILL) when stopped during Redis reconnection.
- Existing initialization-repeat/recreation, exact credential hashes/rows, missing-identity startup gates, and missing-database-password non-regeneration cases continue to pass. API mounts only its own secret read-only; Redis and PostgreSQL publish no host ports. Worker remains unmounted and idle.
- Captured stdout/stderr logs are compared against hashes of all generated test passwords/secrets; no matching value is present. No private volumes, raw prompts, or credential/environment dump is exported.
- `npm run test:containers`: standalone API/worker image builds, process lifecycle, runtime restrictions, and initialization-tool exclusion passed after the dependency/health changes.

`npm ci --ignore-scripts --no-audit --no-fund` passed from the updated lockfile. Subsequent `npm run check`, `npm run test:database`, and the final Compose outage/log-stream checks passed again. Relative Markdown links, formatting, and `git diff --check` also passed.

## Security findings and limits

The 2026-11-17 audit changed from the prior day's 24 moderate affected package entries to **44 entries: 34 high and 10 moderate**. The high findings stem from the new picomatch ReDoS advisory in Jest's tool graph, not the new API clients. The scoped API/worker production audit still reports **0** findings. These counts are affected package entries, not distinct root advisories.

The installed picomatch versions are 2.3.2 and 4.0.7. The current latest 4.x/public latest is 4.0.7, within the reported affected range (`<=4.0.7`); no compatible patched stable update was available in the checked metadata. npm proposes major downgrades for Jest/tooling, which are not applied. No unvalidated major override or suppression is introduced. The prior glob/minimatch tooling findings also remain. Initializer-image operational dependencies and OS images are not declared security-clean.

These are partial OPS-01/OPS-06/SEC-14 and dependency-recovery results for the current health surface. They do not demonstrate ticket processing, authorization, rate-limiter fail-closed behavior, Redis memory-pressure writes, Kafka durability, worker readiness, queued-job recovery, complete telemetry, benchmark/minimum hardware, or the full phase-1 exit. The current fixed readiness contract will need explicit evolution as business prerequisites are implemented.
