# Startup configuration review

Status: prepared for exact-patch review; not committed or pushed.

## Purpose and behavior

The API previously always bound to loopback port 3000, and both entry points ignored deployment mode. This slice introduces the shared `@lab/configuration` workspace, consumed by both entry points, using pinned Zod 4.6.7. It validates the process environment before any Nest context or listener is created.

Both roles accept only `APP_MODE=local`, defaulting to local when absent. The API accepts explicit loopback IPv4/IPv6 or `0.0.0.0` and an unambiguous decimal TCP port in 1–65535; defaults remain loopback and 3000. Unsupported values fail instead of silently choosing a fallback. The worker only reads its applicable mode setting. Unrelated environment variables are ignored without modifying the input.

Configuration returns frozen values. Generic errors contain neither raw input nor a nested Zod error. Existing entry-point catch handlers emit fixed safe failure events and set exit code 1. This is startup validation, not tenant authorization or host isolation. Explicit `0.0.0.0` is appropriate only when the operator intends to bind all IPv4 interfaces.

The build compiles the configuration workspace before its consumers, including declaration output for TypeScript resolution. The type-check command prepares these declarations first. No business behavior, infrastructure, database identity, dependency readiness, or hosted deployment is added. The API remains not ready and the worker remains idle.

## Proposed commit and affected files

Proposed message: `feat: validate local API and worker startup configuration`.

- `packages/configuration/package.json`, `packages/configuration/tsconfig.json`, and `packages/configuration/src/index.ts`: shared runtime validation and generated declaration configuration.
- Root `package.json` and `package-lock.json`: workspace discovery, build ordering, exact package resolution and integrity.
- `apps/api/package.json` and `apps/worker/package.json`: explicit shared package dependencies.
- `apps/api/src/main.ts` and `apps/worker/src/main.ts`: validate before Nest startup and use configured API bind settings.
- `tests/configuration.test.cjs`: defaults, valid boundaries, ambiguous/out-of-range ports, unsupported addresses/modes, and generic errors.
- `tests/startup-configuration.test.cjs`: subprocess exits and output for invalid mode/port/host; occupied configured port proves actual listener configuration and safe failure.
- `tests/lifecycle.test.cjs`: explicitly selects supported local mode for worker lifecycle isolation.
- `docs/operations/local-environment.md`, `docs/architecture/repository.md`, `docs/README.md`, and this review: implemented settings, package scope, limitations, and evidence.

Review the complete patch, including new files and the lockfile, before committing. No commit or push is implied by this document.

## Verification on 2026-11-16

Environment: macOS arm64, Node 24.22.3 from the existing temporary cache, npm 10.2.4. Existing pinned NestJS, TypeScript, and Jest versions are unchanged.

Red: before implementation, `npm run build` succeeded and the two subprocess tests for unsupported `APP_MODE` failed. Both processes ignored the value and stayed running until the explicit 3-second test timeout killed them. They did not fail from missing modules or a test setup error. The tests expected immediate exit code 1 and fixed safe output.

Green: `npm run check` passed formatting, all three workspace type checks/builds, and 40 tests in 3 suites. The subprocess tests now exit without timeout and return the expected generic failure event. Additional tests exercise actual binding to an occupied ephemeral loopback port. Loopback socket tests require sandbox permission in this environment.

Clean install: `npm ci --ignore-scripts --no-audit --no-fund` passed, then `npm run check` passed again with 40 tests in 3 suites. No required test was skipped. Documentation relative-link and whitespace checks also passed.

- Runtime dependency audit: `npm audit --omit=dev --json` passed with 0 reported findings.
- Full audit: `npm audit --json` remains nonzero, now reporting 18 moderate affected package entries rooted in Jest development dependencies. The earlier low finding is no longer reported by the advisory service; no existing dependency upgrade or override is claimed to have fixed it. This patch changes no existing locked dependency versions. Findings remain unresolved, with no approved suppression.
- No Docker startup, broker/database integration, CI, or full OPS/SEC acceptance is claimed. These remain future phase-1 work.
