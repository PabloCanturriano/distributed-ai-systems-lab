# Compose initialization foundation review

Status: prepared for exact-patch review; not committed or pushed. Previous approved commits through `fdd591d` were pushed before this work.

## Purpose and resulting behavior

The existing bootstrap/migration/identity operations required a trusted caller to provide connections and private files. This patch packages that caller and establishes a Docker-only ordered startup for PostgreSQL, initialization jobs, and the minimal API/idle worker.

A root, networkless secret-preparation job generates private password files on first install. PostgreSQL starts only after it completes; bootstrap waits for real TCP readiness; migration and seed jobs use independently authenticated non-admin logins and limited mounts. Applications wait for successful seeding. Every job uses a read-only root filesystem and no Docker socket. Application images retain their non-root runtime and contain no initialization tooling.

Existing role attributes, memberships, connection grants, passwords, and secret-file properties are checked. No role/password rewrite or missing-password regeneration is used to fix an existing installation. The identity protocol continues to preserve raw credentials between restarts and refuse replacement after committed-file loss.

The API needs a separate ingress network for host publication. The first integration run completed initialization but caught that an internal-only API network yielded no published port. The API now joins backend plus ingress, while PostgreSQL/jobs remain backend-only. This permits API outbound connectivity; it is not a network egress sandbox.

Business readiness remains 503. Kafka/Redis, telemetry, authenticated APIs, application database connections/reconnect, job processing, and CI remain future work. The Compose `healthy` API status means liveness. No complete OPS-01 or phase-1 exit is claimed.

## Proposed commit and affected files

Proposed message: `feat: orchestrate PostgreSQL initialization with Docker Compose`.

- `compose.yaml`: pinned PostgreSQL, separate secret/bootstrap/migration/seed stages, persistent scoped volumes, internal dependency network, API ingress loopback publication, startup gates, and graceful-stop bounds.
- `database/src/database-secrets.ts`: private UID-1000 database password files, first-install creation, syncing, non-overwrite publication, and refusal to regenerate missing files after PostgreSQL initialization.
- `database/src/database-logins.ts`: five restricted login roles, exact role membership checks, bounded administrative transaction, and preserved existing passwords.
- `database/src/initialize.ts`: validated local-only command entry point, file-based connection credentials, bounded connections/queries, role selection, job orchestration, password authentication checks, and safe events.
- `database/src/index.ts`: export the trusted login-provisioning operation.
- `infra/docker/Dockerfile`: separate database tool build/dependency/runtime targets; no tooling added to API/worker runtime images.
- `.dockerignore`: permit reviewed database build inputs while explicitly excluding known private-state filenames even underneath permitted source directories.
- `scripts/compose-smoke.mjs` and root `package.json`: separate isolated Compose verification command and narrowly scoped cleanup.
- `tests/database/foundation.test.cjs`: actual login authentication, assigned-role access, denied escalation, password preservation, and incompatible-membership refusal.
- `tests/initializer-configuration.test.cjs`: subprocess failure behavior for unsupported action/mode, without leaking configured values.
- `README.md`, `CONTRIBUTING.md`, `docs/README.md`, `docs/roadmap.md`, `docs/architecture/security.md`, `docs/quality/testing.md`, `docs/operations/local-environment.md`, `docs/operations/database-foundation.md`, `docs/operations/local-identities.md`, `docs/operations/compose-foundation.md`, and this review: implemented path, command semantics, secret ownership, test evidence, and remaining gaps.

The database schema/migrations and pinned package/base-image versions are unchanged. No dependency installation or lockfile change is required. Review all new files together with the diff before committing; approval and push remain separate.

## Verification on 2026-11-16

Environment: macOS arm64 host; Node 24.22.3/npm 10.2.4; Docker Desktop engine 29.2.1; Docker Compose v5.1.0; Linux arm64 container execution. Existing Node and PostgreSQL/pgvector image digests remain pinned as in earlier reviews. Other Compose/OS/architecture combinations are not established by this run.

This infrastructure slice is verified through real startup and failure checks. No synthetic missing-business-behavior TDD result is claimed. The first complete startup exposed the missing API port on an internal-only network; the corrected ingress configuration passed the same real publication assertions.

- `docker compose ... config --quiet`: passed configuration validation.
- `npm run test:database`: 27 tests passed against real PostgreSQL, including the new login-provisioning case. Actual password authentication succeeds after repeat provisioning and after supplying different values that must not replace existing passwords. A runtime login cannot select the migration role. An extra privileged membership is rejected rather than repaired.
- `npm run check`: formatting, four workspace type checks/builds, and 42 tests in 4 fast suites passed. Two new initializer subprocess cases exit 1 promptly with only `initialization_failed` and no stdout.
- `npm run test:compose`: fresh database volumes reach completed initialization, two tenants/six principals/six credentials/one manifest, all expected job exit codes, private UID/mode, scoped mounts, loopback-only API publication, internal/unpublished PostgreSQL, liveness 200, and readiness 503.
- Repeating `up`, then removing/recreating containers without removing volumes, preserves the exact private manifest and all six database-password hashes, as well as all identity rows. A direct seed repeat reports unchanged.
- Removing the committed test identity file makes seed/startup fail and leaves API/worker stopped; database rows remain. Removing a test database password then blocks startup before PostgreSQL starts, and the missing file is not regenerated.
- Captured logs do not contain any of that run's generated password or identity-secret values; the host test compares token hashes rather than printing values. No volume/environment/credential dump is exported.
- Cleanup removes only the uniquely named test project's containers/networks/volumes/local image tags. It does not prune Docker or target a developer installation.

`npm run test:containers` passed again after the Docker build-context/target changes, confirming both application images retain their packaging and runtime guarantees. Final formatting, relative Markdown links, and `git diff --check` also passed. Unrelated `.idea/` editor files are preserved and excluded from this patch.

## Limits and remaining risk

This supplies concrete initialization/restart/failure-gate evidence for part of OPS-02, OPS-03, OPS-06, SEC-12, SEC-13, and SEC-14. Full acceptance still requires application dependency readiness, immutable corpus seeding, all module write grants, Kafka/Redis, queued work, recovery, operational telemetry, reset, and the authenticated Docker-only ticket demo. Dependency conditions do not prove runtime recovery. No performance/minimum-resource claim, cross-architecture run, production hosting, or OS-image security scan is included.

The known 24 moderate package-audit entries in the development/migration/Testcontainers tool graph remain unresolved. The new initializer image contains the operational node-pg-migrate dependency chain and therefore is affected by its existing findings; API/worker production dependency scope is unchanged. No suppression or security-clean claim is introduced. SQL utility statements require escaped password literals; no untrusted input is accepted, detailed exceptions are not emitted by the initializer, and no automatic password rotation is performed. PostgreSQL's trusted host/operator boundary remains as documented.
