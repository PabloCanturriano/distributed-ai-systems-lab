# Database bootstrap and identity migration review

Status: prepared for exact-patch review; not committed or pushed. The preceding Docker packaging patch was committed separately as `e2f7ee1`.

## Purpose and scope

This slice introduces trusted database initialization operations, the first ordered schema migration, and real PostgreSQL integration tests. It establishes a place to build identity provisioning and application persistence without giving runtime roles administrative rights.

Bootstrap transactionally creates the vector extension, non-login privilege roles, and a migration-owned schema. It removes public database/schema privileges and fails on incompatible pre-existing role attributes, parent memberships, or schema ownership. It is restricted operationally to a dedicated lab cluster/database; it changes cluster-wide role definitions and target-database privileges. Existing roles are not rotated, elevated, or silently replaced.

The migration creates only tenants, principals, credential digests, and explicit grants. A separate schema history table is managed by node-pg-migrate. The migration runner requires current role `lab_migrator`, checks ordering, retains advisory locking, and wraps all pending changes in one transaction. Both bootstrap and migrations use bounded SQL/lock waits. No application role receives ownership or migration-history access.

The package contains no credential loader, database CLI, Compose target, persisted login, seed dataset, auth endpoint, ticket table, or application connection. API readiness remains 503 and the worker remains idle. Privilege groups are not yet provisioned runtime identities. Upgrade evidence below covers a synthetic pending migration batch; there is no prior application release to upgrade.

## Proposed commit and files

Proposed message: `feat: establish PostgreSQL identity schema and migration boundaries`.

- `database/package.json`, `database/tsconfig.json`, and `database/src/index.ts`: private ESM tooling workspace with explicit connection ownership and initialization operations.
- `database/bootstrap/001-roles.sql`: transactional role/schema/extension setup and public privilege removal.
- `database/migrations/1794787200000_identity-foundation.cjs`: table constraints, limited grants, and explicit refusal of destructive down migration.
- Root `package.json` and `package-lock.json`: exact database/test dependencies, workspace discovery/build, separate database verification command.
- `jest.config.cjs` and `jest.database.config.cjs`: separate fast and real-database suites; no passing skip fallback.
- `tests/database/foundation.test.cjs`: disposable loopback PostgreSQL, independently authenticated non-admin fixtures, schema/privilege/rollback checks.
- `.dockerignore` and `infra/docker/Dockerfile`: include the new workspace manifest for lockfile resolution while compiling only application workspaces inside application image builds.
- `scripts/container-smoke.mjs`: also verifies migration tooling and database workspace contents are absent from application runtime images.
- `README.md`, `docs/README.md`, `docs/roadmap.md`, `docs/architecture/data-model.md`, `docs/architecture/security.md`, `docs/operations/local-environment.md`, `docs/operations/database-foundation.md`, and this review: implemented subset, command boundaries, results, and limitations.

The complete patch includes all new files and the lockfile. Commit approval and push permission remain separate.

## Versions and environment

Verified on macOS arm64, host Node 24.22.3/npm 10.2.4, Docker Desktop engine 29.2.1, linux/arm64 database execution. New exact versions: pg 8.23.1, node-pg-migrate 9.0.0, @types/pg 8.23.1, @testcontainers/postgresql 12.2.1.

Database image: `pgvector/pgvector:0.8.7-pg17-bookworm@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd`. The public registry returned that multi-platform digest. Actual SQL reports PostgreSQL `server_version_num=170012` (17.12) and pgvector 0.8.7. The test requires at least 17.12 and rejects a different major line. Base-image OS scanning and other architectures remain unverified.

## Verification

Initial compilation exposed a library declaration type that could not be named in our emitted public declarations. The wrapper now exposes an explicit numeric applied-count result; this setup correction is not claimed as a behavioral red step.

Red: after compilation and real container/bootstrap succeeded, the clean-install test failed because the migrations directory contained no migration: expected 1 applied migration, received 0. This established the missing behavior independently of environment/setup failures.

Green: adding the identity migration made the schema test pass. The first role-escalation fixture still used an administrative session with `SET ROLE`; PostgreSQL correctly allowed that session to select another role. The fixture was corrected to authenticate separate non-admin login roles with random passwords. All privilege tests now exercise non-admin sessions and the expected denied operations.

- `npm run check`: formatting, four workspace type checks/builds, and 40 tests in 3 fast suites passed.
- `npm run test:database`: 11 tests passed against actual PostgreSQL, including clean migration, repeat bootstrap/migration preserving rows/history, role attributes, installed extension, admin-identity rejection, runtime DDL/role/data-write denial, migration-role escalation denial, restricted seed inserts, schema constraints, atomic pending-batch rollback, and refusal to rewrite an incompatible existing role.
- Failure injection adds two temporary pending migrations: a table creation followed by an invalid query. Neither table nor history entry survives. The prior migration remains applied, and retrying the real source is a no-op.
- `npm run test:containers`: both API/worker targets rebuilt and passed runtime smoke checks, including absence of migration tooling/database workspace contents in final images.
- `npm ci --ignore-scripts --no-audit --no-fund`: clean lockfile install passed; subsequent `npm run check` and `npm run test:database` passed again (40 fast tests and 11 integration tests).
- Relative Markdown links, formatting, and `git diff --check`: passed.

These checks provide partial evidence for OPS-02/OPS-03 and SEC-14. They do not complete those scenarios: persistent bootstrap credentials, immutable real seeds, dependent application readiness, the full table/privilege matrix, Compose, and the ticket workflow remain unimplemented.

## Dependency findings

The scoped audit of API/worker production dependencies reports 0 findings. The full repository audit reports 24 moderate affected package entries: the existing Jest chain plus migration/Testcontainers tooling chains, rooted in glob/minimatch resource-exhaustion advisories. node-pg-migrate is an operational tool dependency, so these are not all development-only findings. They remain unresolved and are not an approved suppression; automated major-version downgrades are not applied. The runtime image smoke checks ensure these tools are absent from API/worker images. Recheck before committing or enabling initialization against persistent data. Package audit is not an OS-image scan.
