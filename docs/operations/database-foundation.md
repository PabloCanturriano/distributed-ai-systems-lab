# Database identity foundation

Status: the first bootstrap and ordered identity migration are implemented for isolated integration verification. Application connections, persistent credentials, tenant/demo provisioning, Compose, and usable application readiness are not implemented yet.

## Responsibilities

The private `@lab/database` workspace exports two operations for trusted tooling:

- `bootstrapDatabase(admin)`: with a dedicated connected administrative client, creates the pgvector extension, the `lab` schema, and five non-login privilege roles in one transaction. Public database/schema privileges are removed. Existing incompatible role attributes, role memberships, or schema ownership cause a rollback rather than automatic rewriting.
- `migrateDatabase(migrator, directory?)`: with a dedicated connected client whose current role is `lab_migrator`, applies ordered pending migrations using node-pg-migrate's advisory locking and a shared transaction. It returns the number applied. The optional directory is a trusted tooling input for upgrade/failure verification, never an HTTP/model/tool argument.

The caller owns connection credentials, connection creation, and shutdown. Clients must not already be in a transaction. Migration sessions retain the configured 5-second lock timeout, 10-second statement timeout, and runner search path; use a dedicated connection. The wrapper does not print raw SQL/errors to application logs; callers remain responsible for safe error reporting.

Bootstrap is intended only for a dedicated lab cluster/database: role names are cluster-wide, and the operation intentionally revokes public privileges in its target database. It does not run from API/worker startup. Connection ownership and utility-statement behavior follow [node-postgres](https://node-postgres.com/features/transactions); migration controls follow [node-pg-migrate](https://salsita.github.io/node-pg-migrate/api).

## Initial schema and permissions

The migration creates `lab.tenants`, `lab.principals`, and `lab.auth_credentials`, plus runner-managed `lab.schema_migrations`. It enforces UUID keys, tenant membership, reader/requester/operator roles, bounded tenant names, 32-byte credential digests, and valid optional credential expiry. Raw bearer secrets are not stored.

| Role                      | Current privileges                                                       |
| ------------------------- | ------------------------------------------------------------------------ |
| `lab_migrator`            | Owns the `lab` schema and migrated tables/history                        |
| `lab_seed`                | Select and insert identity rows; cannot update, delete, or change schema |
| `lab_api`                 | Select identity rows; cannot write them or migrate                       |
| `lab_worker`, `lab_relay` | Schema usage, no identity-table access                                   |

These are non-login privilege roles without inheritance, superuser, database creation, role creation, replication, bypass-RLS, or parent-role memberships. Later provisioning must create separately scoped authenticated connections. No persistent login/password, bearer credential, seed manifest, or identity is created by this slice. The fictional rows and random connection passwords used in tests disappear with that test's database.

Future ticket-processing migrations will grant only the permissions each operation needs. This schema does not implement ticket tenancy, authentication, credential verification, or row-level security. Destructive down migration is deliberately unsupported; use an explicitly reviewed forward migration.

## Run the integration checks

With Node 24.22.3, an available Docker engine, and registry access:

```sh
npm ci --ignore-scripts
npm run test:database
```

Tests use Jest's separate integration configuration, the ESM migration package, and Node's experimental VM modules flag supplied by the npm script. A missing Docker runtime fails this command; it is not treated as a skipped passing test. `npm run check` remains the fast formatting/type/build/lifecycle gate and does not include database integration. No CI job enforces either command yet.

Testcontainers starts pinned PostgreSQL 17/pgvector on a randomly assigned loopback-only port, with a random administrative password. Permission assertions use separate authenticated non-admin test logins, each restricted to its target privilege role. The harness closes its clients, stops only its own container, and removes its temporary failure-migration directory. Testcontainers' cleanup helper has host-operator authority; no application image receives a Docker socket.

See [review evidence](../quality/reviews/0004-database-foundation.md) for exact versions, failure/recovery results, and remaining security findings.
