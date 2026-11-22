# Docker Compose database foundation

Status: PostgreSQL initialization and process-lifecycle startup are implemented and verified. The [API readiness adapter](api-readiness.md) now checks PostgreSQL bootstrap metadata and Redis. The worker remains idle. The [Kafka foundation](kafka-foundation.md) adds a persistent broker and explicit topics; authenticated ticket submission/reads and rate limiting are implemented; telemetry and ticket processing remain future work. The optional relay below publishes stored events. This command does not complete phase 1 or provide the planned ticket demo.

## Start and stop

From the repository root, with Docker running and network access for image/package downloads:

```sh
docker compose up --build --detach --wait --wait-timeout 180
```

No host Node, copied secret file, public password, or external provider key is needed. The API is published at `http://127.0.0.1:3000`; to choose a different host port:

```sh
LAB_API_PORT=3001 docker compose up --build --detach --wait --wait-timeout 180
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
6. `api` starts after seeding and Redis health, mounts only its own database password read-only, and checks PostgreSQL plus Redis. `worker` starts after seeding and successful `kafka-init`, and remains idle without credential mounts. Neither mounts raw demo credentials. Redis starts independently on the internal backend network with no host port or persistence.
7. `kafka` starts independently as a persistent combined KRaft broker/controller without host ports. After broker health, `kafka-init` creates or verifies the two fixed topics. An incompatible existing topic blocks newly starting workers without automatically altering the topic. The API has no Kafka dependency.

All initializer commands emit fixed completion/failure events with safe counts/status where applicable. No password is passed as a command argument, embedded in Compose environment values, or written into an image. The administrative bootstrap job can read all five login passwords to provision/verify them; those mounts are read-only. The raw demo credential volume is mounted only by trusted secret-volume preparation and seeding, with CLI access still future work.

The database and jobs use the internal backend network. The API also has an ingress network so Docker can publish its loopback port; that network permits API outbound connectivity. No tenant isolation or hosted-deployment security is implied. The API image's healthcheck uses dependency readiness in Compose, so `--wait` checks the implemented prerequisites. `/health/live` stays 200 independently of dependencies; `/health/ready` is 200 only for valid PostgreSQL bootstrap metadata plus a responsive Redis. These checks do not establish ticket processing. The worker has no readiness probe yet.

## Failure handling

Missing or altered database password material, incompatible roles, failed migrations, or missing committed identity credentials block downstream startup. Existing database/credential volumes remain intact. Correct the cause through a reviewed operator action; repeating `up` does not rotate passwords or erase data. Initial PostgreSQL setup failures are also retained for investigation, not repaired by deleting data automatically.

The mounted secrets must retain UID/GID 1000 ownership, mode 0700 directories, and mode 0600 regular files. The trusted secret initializer changes ownership only for brand-new empty root-owned volumes. Existing incompatible volumes fail. Administrative passwords remain accessible to the trusted Docker host and initialization jobs; these local secret volumes are not a production secret manager.

Compose dependencies gate startup only. The API adapter separately provides tested readiness degradation/reconnection on PostgreSQL/Redis stop or pause, without restarting the API. Consumer/job recovery and automatic application restart policies remain future work; the optional relay retries publication as described below.

## Verification

```sh
npm run test:compose
```

The host-side test needs Node 24 and Docker Compose. It creates a unique isolated project, uses an ephemeral loopback API port, verifies named-volume persistence and scoped mounts, then deliberately removes only that test installation's files to exercise failure gates. It verifies known generated secrets are absent from captured logs using hashes and never prints them. Cleanup removes only its project's containers, networks, volumes, and local service image tags. Build caches/base images remain.

See [review evidence](../quality/reviews/0006-compose-foundation.md) for exact versions, actual checks, and limitations.

## Opt-in local publication relay

After building the reviewed relay patch, enable real outbox publication explicitly:

```sh
docker compose --profile messaging up --build --detach --wait --wait-timeout 180
```

The separate `relay` entry point polls one leased event at a time, sends its exact stored bytes to the fixed Kafka topic with ticket ID as key, and marks publication only after broker acknowledgement. It uses only its read-only relay-password volume and the restricted `lab_relay` role. The default `worker` remains idle. The consumer patch prepared for review below adds durable job admission; no executor is enabled, so published/admitted tickets remain queued. API readiness still depends only on PostgreSQL/Redis.

Native downloads are checksum-pinned for Node 24 ABI 137 on Linux glibc arm64/amd64; npm lifecycle scripts remain disabled. The relay-specific build stage fails on an unsupported artifact/platform without changing the default API/idle-worker build path. Build downloads need network access. This trusted local profile uses the existing plaintext internal broker, without production TLS/ACL or high availability claims.

A broker outage keeps events pending and retryable. Shutdown interrupts publication and stops claiming; an acknowledgement followed by a crash before SQL marking may produce duplicate delivery after the 30-second database lease expires. Event identity and bytes remain stable. Future consumers must deduplicate. Safe fixed log events expose no event payload or credential.

```sh
npm run test:relay
# Optional alternate-platform execution; Docker Desktop may emulate it.
RELAY_TEST_PLATFORM=linux/amd64 npm run test:relay

docker compose --profile messaging stop relay
docker compose --profile messaging down
```

`--wait` verifies dependency gates but is not a relay-delivery readiness probe. See [review 0015](../quality/reviews/0015-local-kafka-relay.md) for actual platform, failure and delivery evidence. Using the same profile when stopping/removing the stack includes its relay container. Volumes are retained by the operational `down` command.

## Opt-in scheduling consumer

The committed implementation under approved ADR-0007 adds `consumer` to the same `messaging` profile. It uses only `/run/lab/worker/password` through its read-only worker-password volume and the restricted `lab_worker` role. It admits each scheduling record transactionally before explicitly committing its next Kafka offset. Duplicate event identities/generations cannot create duplicate jobs; invalid events must enter durable quarantine first.

A PostgreSQL outage keeps the current callback pending and prevents later records from advancing past it. Ambiguous offset-commit failure stops the process; restart the consumer after correcting the dependency with `docker compose --profile messaging up --detach --no-deps consumer`. Broker redelivery uses the existing inbox/job identity. The SDK has no implemented `stop()` method, so shutdown interrupts new admissions and calls `disconnect()` outside the message callback, with a 12-second process deadline inside Compose's 15-second grace. A forced deadline exit may leave an accepted SQL write or broker commit uncertain; redelivery remains safe.

The SDK uses Number internally for offsets. The adapter refuses unsafe current/next offsets before SQL or acknowledgement; the SQL bigint range alone is not a claim of full SDK precision. Fetch/cache settings are bounded, but their limits are not a measured minimum memory requirement. Consumer startup/liveness is not a delivery-readiness probe.

```sh
npm run test:consumer
# Optional alternate-platform client execution; Docker Desktop may emulate it.
CONSUMER_TEST_PLATFORM=linux/amd64 npm run test:consumer
```

The smoke suite covers real HTTP -> relay -> consumer -> durable job, independent group-offset inspection, duplicate identities, quarantine, PostgreSQL outage, shutdown, and a host-killed SQL-before-offset checkpoint during rebalance. Test actors/producer fixtures run only in disposable containers and are not copied into application images. See [review 0017](../quality/reviews/0017-local-scheduling-consumer.md). This adds no executor, answer/result generation or replay.

## Execution ownership development boundary

The [ownership patch](../quality/reviews/0018-execution-ownership.md) prepares a PostgreSQL protocol for consumer-created jobs: claim with a 30-second lease, renew while current, reschedule classified transient failure with bounded jitter, and atomically fail/exhaust the job with one failure outbox record. No executor process polls jobs yet, and this patch does not generate or persist successful answers.

Its integration tests use authenticated non-admin worker sessions. `npm run test:consumer` additionally invokes the ownership adapter through a trusted test operator on a real consumer-created job, then verifies the relay publishes the exact terminal event to `tickets.execution-failed.v1` without scheduling another job. That probe intentionally produces one failed execution; it is not an enabled executor service or a public fault-injection route. Terminal HTTP result/failure reads remain unimplemented and fail closed.

```sh
npm run test:database
npm run test:consumer
```

The future executor loop must own the five-second heartbeat cadence, monotonic 60-second attempt deadline, cancellation and provider classification. SQL ownership is checked under locks with database time; an expired token cannot renew or finalize the current owner. Lease fencing does not prevent repeated external calls or their cost after a crash. A new result-persistence patch must use the same lock order and ownership checks atomically with its writes.
