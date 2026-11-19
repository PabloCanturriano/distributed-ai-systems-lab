# Docker Compose database foundation

Status: PostgreSQL initialization and process-lifecycle startup are implemented and verified. The [API readiness adapter](api-readiness.md) now checks PostgreSQL bootstrap metadata and Redis. The worker remains idle. Kafka, telemetry, authenticated routes, rate limiting, and ticket processing are not wired yet. This command does not complete phase 1 or provide the planned ticket demo.

## Start and stop

From the repository root, with Docker running and network access for image/package downloads:

```sh
docker compose up --build --detach --wait --wait-timeout 120
```

No host Node, copied secret file, public password, or external provider key is needed. The API is published at `http://127.0.0.1:3000`; to choose a different host port:

```sh
LAB_API_PORT=3001 docker compose up --build --detach --wait --wait-timeout 120
```

Inspect only safe initialization events:

```sh
docker compose logs bootstrap migrate seed
```

Stop and remove this installation's containers/networks while preserving named data/credential volumes:

```sh
docker compose down
```

The next `up` reuses passwords, identity credentials, schema history, and rows. There is no automatic credential repair or destructive reset command. Removing volumes loses the corresponding data and credentials; that is a separate explicit operator action. Do not use a machine-wide prune as recovery.

## Startup order and privilege separation

[Compose dependency conditions](https://docs.docker.com/compose/how-tos/startup-order/) gate these stages:

1. `secrets`: a networkless trusted one-shot process prepares private volumes and generates six 256-bit database passwords. It runs as root only to set file ownership; capabilities are limited to CHOWN and DAC_OVERRIDE, with a read-only root filesystem and no Docker socket. It mounts PostgreSQL data read-only to detect an existing installation. Existing data forbids regenerating a missing database password.
2. `postgres`: the pinned PostgreSQL 17.12/pgvector 0.8.7 image uses the administrative password file. TCP readiness avoids mistaking the entrypoint's temporary socket-only server for the final server. PostgreSQL publishes no host port. Its official entrypoint starts as root for data-volume preparation and drops to the database user for the server.
3. `bootstrap`: a non-root administrative job creates privilege groups, extension/schema, and five login roles. Each login has no inherited privileges and may select only its assigned privilege group. Existing mismatched attributes/memberships fail instead of being rewritten. Existing passwords are authenticated and never rotated automatically.
4. `migrate`: a non-root job mounts only its own password volume, authenticates as `lab_migrator_login`, selects `lab_migrator`, and applies ordered migrations.
5. `seed`: a non-root job mounts only its database password and writable demo-credential volume. It selects `lab_seed` and executes the [durable identity protocol](local-identities.md). Raw fictional credentials are stored under `identities/identities-v1.json` in that volume.
6. `api` starts after seeding and Redis health, mounts only its own database password read-only, and checks PostgreSQL plus Redis. `worker` starts after seeding and remains idle without credential mounts. Neither mounts raw demo credentials. Redis starts independently on the internal backend network with no host port or persistence.

All initializer commands emit fixed completion/failure events with safe counts/status where applicable. No password is passed as a command argument, embedded in Compose environment values, or written into an image. The administrative bootstrap job can read all five login passwords to provision/verify them; those mounts are read-only. The raw demo credential volume is mounted only by trusted secret-volume preparation and seeding, with CLI access still future work.

The database and jobs use the internal backend network. The API also has an ingress network so Docker can publish its loopback port; that network permits API outbound connectivity. No tenant isolation or hosted-deployment security is implied. The API image's healthcheck uses dependency readiness in Compose, so `--wait` checks the implemented prerequisites. `/health/live` stays 200 independently of dependencies; `/health/ready` is 200 only for valid PostgreSQL bootstrap metadata plus a responsive Redis. These checks do not establish ticket processing. The worker has no readiness probe yet.

## Failure handling

Missing or altered database password material, incompatible roles, failed migrations, or missing committed identity credentials block downstream startup. Existing database/credential volumes remain intact. Correct the cause through a reviewed operator action; repeating `up` does not rotate passwords or erase data. Initial PostgreSQL setup failures are also retained for investigation, not repaired by deleting data automatically.

The mounted secrets must retain UID/GID 1000 ownership, mode 0700 directories, and mode 0600 regular files. The trusted secret initializer changes ownership only for brand-new empty root-owned volumes. Existing incompatible volumes fail. Administrative passwords remain accessible to the trusted Docker host and initialization jobs; these local secret volumes are not a production secret manager.

Compose dependencies gate startup only. The API adapter separately provides tested readiness degradation/reconnection on PostgreSQL/Redis stop or pause, without restarting the API. Job recovery, worker reconnection, and automatic application restart policies remain future work.

## Verification

```sh
npm run test:compose
```

The host-side test needs Node 24 and Docker Compose. It creates a unique isolated project, uses an ephemeral loopback API port, verifies named-volume persistence and scoped mounts, then deliberately removes only that test installation's files to exercise failure gates. It verifies known generated secrets are absent from captured logs using hashes and never prints them. Cleanup removes only its project's containers, networks, volumes, and local service image tags. Build caches/base images remain.

See [review evidence](../quality/reviews/0006-compose-foundation.md) for exact versions, actual checks, and limitations.
