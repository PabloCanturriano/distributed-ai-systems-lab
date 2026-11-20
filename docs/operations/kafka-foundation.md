# Local Kafka foundation

Status: implementation approved and committed as `f679c74`. The broker and topic initializer are wired into Compose. The worker remains idle; no application Kafka client, outbox publisher, inbox, or execution loop is installed.

## Start and inspect

Use the [Compose startup command](compose-foundation.md). Kafka starts independently from PostgreSQL and Redis; the worker waits for seeding and successful topic initialization. API readiness still checks only PostgreSQL and Redis.

```sh
docker compose up --build --detach --wait --wait-timeout 180
docker compose logs kafka-init
docker compose exec -T --env KAFKA_HEAP_OPTS='-Xms32m -Xmx128m' kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --describe
```

The official Apache Kafka 4.4.0 JVM image is pinned by digest in Compose and the initializer Dockerfile. It runs one combined KRaft broker/controller with fixed non-secret local cluster ID `MkU3OEVBNTcwNTJENDM2Qk`. Clients inside the internal backend network use `kafka:9092`; controller traffic uses port 9093. Neither port is published to the host. This local plaintext installation has no TLS, authentication, or ACLs and trusts the Docker host and backend-network participants.

The broker inherits the official non-root `appuser`, drops Linux capabilities, and enables no-new-privileges. Its root filesystem remains writable because vendor startup generates configuration. Heap is 256–512 MiB within a 1 GiB container limit. The healthcheck launches a separate small JVM. These are local test settings, not a measured minimum or a capacity guarantee.

## Topics and failure gates

| Topic | Partitions | Replication | Minimum ISR | Cleanup | Retention |
| --- | --- | --- | --- | --- | --- |
| `tickets.execution-requested.v1` | 3 | 1 | 1 | delete | 604800000 ms (7 days) |
| `tickets.execution-failed.v1` | 3 | 1 | 1 | delete | 604800000 ms (7 days) |

`kafka-init` uses the same pinned distribution, runs non-root with a read-only root filesystem and temporary Java paths, and mounts no database or demo credentials. It accepts only local mode and no arguments. Each CLI invocation has a 30-second process bound plus finite request/API connection settings. It creates missing fixed topics and verifies existing settings, including exact delete-only cleanup. Compatible repeats succeed; incompatible partitions, replication, retention, cleanup, or minimum ISR fail with a fixed `kafka_topics_failed` event. Success emits `kafka_topics_complete` with a topic count. It never changes or deletes an incompatible topic to repair it.

Automatic topic creation and topic deletion are disabled. This does not make backend participants read-only administrators: operator tooling can still alter topic settings. Review drift before retrying; do not erase volumes or rewrite partition counts as an automatic recovery step. Compose startup gates do not continuously stop an already running worker on later drift.

## Persistence and limitations

Project-scoped `kafka_data` stores broker data and KRaft metadata under `/var/lib/kafka/data`. `docker compose down` preserves it; a later `up` reuses it. Retain the cluster ID with its metadata. Removing the volume loses messages and metadata; it requires a separate explicit operator decision. Never prune unrelated Docker resources.

Replication factor 1 provides no host/disk fault tolerance. Seven-day retention is a transport policy, not business-state retention or guaranteed indefinite replay. PostgreSQL remains the planned business source of truth. Delayed admission and authorized re-publication require later outbox/recovery work.

## Verify the transport foundation

```sh
npm run test:kafka
```

Node 24 and Docker Compose are required. The test creates a uniquely named disposable project and a separate one-partition probe topic. Bundled Java tools publish a fictional keyed record synchronously with `acks=all` and consume by explicit partition/offset without automatic offset commits. Checks cover broker restart/container recreation, API independence during broker outage, incompatible topic refusal/worker startup blocking, disabled automatic topic creation, and payload absence in default broker/job logs. Cleanup removes only the test project's resources, including its own volumes and local service image tags.

This proves only the tested native-tool transport path. It does not prove KafkaJS compatibility, application admission, durable committed offsets, idempotency, business recovery, or exactly-once effects. The [approved scope](../architecture/kafka-foundation-plan.md) retains a maintenance/compatibility review before introducing a JavaScript client. See [review evidence](../quality/reviews/0008-kafka-foundation.md) for actual results and remaining gates.
