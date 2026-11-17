# Persistent local identity provisioning review

Status: prepared for exact-patch review; not committed or pushed. Database foundation was approved and committed separately as `6e366e9`; Docker packaging is `e2f7ee1`. Both commits remain local pending a separately authorized push.

## Purpose and behavior

The identity schema existed without actual seeded identities or persistent credential material. This slice adds one versioned fictional fixture and a trusted provisioning operation that can be retried without rotating credentials or overwriting identity facts.

Two tenants receive three principals each. Secrets contain 32 cryptographically generated random bytes, encoded as base64url only in a private local JSON file. Database rows store the corresponding SHA-256 digest and principal association. The new immutable seed-state row binds the fixture and credential manifest to the database. `lab_seed` can insert/read this state but cannot update or delete it; no new runtime role grants are introduced.

Provisioning serializes on a PostgreSQL advisory transaction lock. It durably publishes a private complete file before any identity write, then commits identity rows and state together. A failed initial SQL transaction leaves the file available for retry. A committed initialization with missing, changed, corrupt, or unsafe credential material fails rather than rotating secrets. Existing disabled/revoked/expired status is preserved. Fixture changes under the same version are rejected.

The trusted caller owns the database connection and supplies the directory. This is not an HTTP endpoint, model tool, credential-management API, or arbitrary filesystem capability exposed to users. There is no persistent database-login/password provisioning, Compose bootstrap job, CLI, bearer parsing, authentication middleware, or destructive reset yet. API readiness remains 503 and the worker remains idle.

## Proposed commit and affected files

Proposed message: `feat: provision persistent fictional identities without credential rotation`.

- `database/migrations/1794787200010_seed-manifests.cjs`: additive seed-state table and limited seed grants; destructive down migration is unsupported. The previously committed identity migration is unchanged.
- `database/src/identity-fixture.ts`: fixed version, fictional tenants, role membership, aliases, and stable principal IDs.
- `database/src/identity-manifest.ts`: bounded strict manifest validation, generation, private POSIX file handling, exclusive publication, and file/directory syncing.
- `database/src/seed-identities.ts`: role check, serialization, collision detection, idempotent verification, parameterized inserts, SQL rollback, and safe error/result behavior.
- `database/src/index.ts`: export the provisioning operation and its public result type.
- `database/package.json` and `package-lock.json`: reuse already pinned Zod 4.6.7 as an explicit database dependency; no existing package version upgrades.
- `.gitignore`: exclude raw manifest filenames and incomplete private writes.
- `tests/database/foundation.test.cjs`: adapt fresh-install/history expectations for the additive migration, preserve pending-failure ordering, and add identity/recovery/upgrade cases.
- `README.md`, `docs/README.md`, `docs/roadmap.md`, `docs/architecture/security.md`, `docs/operations/database-foundation.md`, `docs/operations/local-environment.md`, `docs/operations/local-identities.md`, and this review: implemented protocol, ownership requirements, command boundaries, and evidence.

Review the full diff, including all new files. Approval to commit this patch does not authorize a push.

## Validation on 2026-11-16

Environment: macOS arm64, host Node 24.22.3/npm 10.2.4, Docker Desktop 29.2.1, PostgreSQL 17.12 and pgvector 0.8.7 using the previously pinned database image. Host credential files use the test process UID; filesystem permissions/directory syncing are verified on this host, not every container-volume platform.

Red: the added manifest-anchor test ran against the existing real database migration and failed because `lab.seed_manifests` did not exist (null relation). The existing 11 database tests passed. The additive migration provides that missing state. The existence assertion was subsequently expressed as a boolean to avoid PostgreSQL search-path-dependent relation rendering.

The initial seeding tests also found that `instanceof Error` was unsuitable for recognizing filesystem errno objects across Jest ESM contexts; this was replaced with a structural code check. Raw filesystem/JSON/schema errors are not emitted by the provisioning API. No synthetic business red-to-green result is claimed for that test-environment correction.

- `npm run test:database`: 26 tests passed, including the existing foundation checks plus the new provisioning/upgrade coverage.
- New assertions cover two tenants/six principals/six credentials, 32-byte secrets and matching database digests, private directory/file modes, repeat startup without rotation or re-enablement, no seed-state update/delete permission, missing file/directory, changed secret or fixture facts, corrupt/oversized files, symbolic links, unsafe permissions, unauthorized current role, and SQL failure recovery after file publication.
- Concurrency is coordinated explicitly: a third session holds the advisory lock; the test observes both seed sessions waiting in `pg_locks` before releasing it. Both finish with one created result, one unchanged result, and no duplicate identities or state.
- Upgrade verification applies only the original migration to a separate test database, inserts a fictional row, then applies the additive migration and repeats it. The row survives, exactly one additional migration applies, and the second run is a no-op.
- `npm run check`: formatting, all four workspace type checks/builds, and 40 fast tests in 3 suites passed.
- `npm run test:containers`: API and worker image builds, runtime restrictions, liveness/unready responses, safe rejection, absence of initialization tooling from final images, and shutdown checks passed.
- Dependency audit: scoped API/worker production audit reports 0 findings; full repository audit still reports 24 moderate affected package entries in the previously identified Jest/migration/Testcontainers chains. No suppression, upgrade, or resolution is claimed. OS-image scanning remains unperformed.

`npm ci --ignore-scripts --no-audit --no-fund` passed, followed by passing fast and database suites. The final directory-durability change also passed a fresh database build/test run. Relative Markdown links, formatting, and `git diff --check` passed.

This provides partial OPS-02/OPS-03 and SEC-12 evidence for the trusted seed operation. Full acceptance remains pending Compose lifecycle, database login provisioning, credential mounts, authenticated HTTP, reset, abrupt interruption/power loss, and the complete ticket journey. Missing-file recovery requires an explicit operator decision; no automatic repair or reset is implemented.
