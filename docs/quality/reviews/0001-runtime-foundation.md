# Initial runtime foundation review

Status: prepared locally for exact-patch review; not committed or released.

## Purpose and scope

The repository previously had architecture documentation only. This patch adds two private npm workspaces, strict TypeScript compilation with decorator metadata, an exact dependency lockfile, formatting, and Jest lifecycle tests against compiled JavaScript. It is the first portion of phase 1, not its exit gate.

The API binds to loopback on port 3000. `GET /health/live` responds with HTTP 200 and `{"status":"alive"}`. `GET /health/ready` deliberately returns HTTP 503 and `{"status":"not_ready"}` until bootstrap and dependency checks exist. The worker creates a Nest application context with no HTTP listener and waits for shutdown; it has no consumer, executor, or relay yet. Framework logs are disabled; startup/failure logs contain only fixed event names and readiness state.

No business credentials, remote provider, database, broker, cache, container image, or telemetry exporter is configured. No shared packages or CLI scaffolding are created without a consumer. The worker's temporary keep-alive interval must be replaced by real role lifecycle handling when that role is implemented.

## Changed files

- Root `package.json`, `package-lock.json`, and `tsconfig.base.json`: private workspaces, pinned tooling, build/check commands, strict compilation.
- `.nvmrc`, `.gitignore`, `.prettierrc.json`, `.prettierignore`, and `jest.config.cjs`: runtime selection, generated/secret file exclusions, formatting, and test discovery. Existing design documents retain their formatting.
- `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/app.ts`, and `apps/api/src/main.ts`: API lifecycle and health endpoints.
- `apps/worker/package.json`, `apps/worker/tsconfig.json`, and `apps/worker/src/main.ts`: idle Nest context and shutdown lifecycle.
- `tests/lifecycle.test.cjs`: real loopback HTTP assertions and subprocess SIGTERM shutdown assertions with bounded startup.
- `README.md`, `docs/README.md`, `docs/architecture/repository.md`, `docs/quality/testing.md`, `docs/roadmap.md`, and this review: current implementation status and evidence.

## Local commands

Use Node 24.22.3 (for example, `nvm install && nvm use` when nvm is available):

```sh
npm ci --ignore-scripts
npm run check
npm run start --workspace=@lab/api
```

In a separate terminal, after building:

```sh
npm run start --workspace=@lab/worker
```

These are development commands, not the planned Docker-only reviewer journey. The API port is fixed for this slice; validated runtime configuration comes with dependency wiring. No lint gate or CI workflow exists yet. `npm run check` runs formatting, type checking, compilation, and lifecycle tests only.

## Validation on 2026-11-16

Test environment: macOS arm64; Node 24.22.3 downloaded into a temporary npm cache without replacing the host's Node 21.6.2; npm 10.2.4. Versions: NestJS 11.2.10, TypeScript 6.0.3, Jest 30.5.2, Prettier 3.10.1, reflect-metadata 0.2.2, RxJS 7.8.2, and Node type definitions 24.19.2. Exact transitive versions and integrity hashes are in the lockfile.

- `npm install --ignore-scripts`: passed, producing the lockfile. A clean `npm ci` remains to be independently verified.
- `npm run check` under Node 24.22.3: passed formatting, both workspace type checks and builds, and 2 lifecycle tests in 1 suite. The first sandboxed run could not bind loopback (`EPERM`); the permitted rerun passed. This environment restriction is not a behavioral red-to-green result. Infrastructure bootstrap uses build/startup evidence rather than a fabricated missing-business-behavior test.
- `npm ls --depth=0`: expected pinned dependencies resolved.
- `npm audit --omit=dev --json`: passed, 0 reported runtime vulnerabilities.
- Full `npm audit`: failed, 19 affected package entries (18 moderate, 1 low), all in Jest's development dependency graph. Root advisories concern glob/minimatch denial of service and deepmerge prototype poisoning. These are unresolved findings, not an approved suppression. The reported automatic major-version downgrade of Jest is not applied. Any override or runner change requires compatibility validation and review before this patch is considered security-clean. Recheck by 2026-11-23 or before committing this slice, whichever is earlier.
- Docker client is installed (29.2.1); the Docker daemon is not running. No container startup, integration, broker/client compatibility, resource, or timing evidence is claimed.

Full OPS/SEC acceptance scenarios remain **not run**. The health assertions cover only the uninitialized process lifecycle; they do not establish OPS-01, OPS-06, or dependency recovery. KafkaJS, database migration tooling, and Testcontainers are not installed until their slice requires them.

## Review and next slice

Proposed commit message: `feat: establish API and worker runtime foundation`.

The complete patch must be reviewed before committing, including new files and the lockfile. No commit or push is authorized by this document. Remaining phase-1 work includes validated runtime configuration, Docker/Compose with pinned images, role bootstrap, migrations, immutable seeds, usable readiness checks, safe structured observability, dependency integration checks, lint, and baseline CI. Security findings must be triaged before commit approval.
