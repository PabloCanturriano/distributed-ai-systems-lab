# Kafka foundation implementation proposal

Status: scope approved by the owner on 2026-11-19 after review of this proposal. Implementation and native transport verification are prepared for exact-patch review; see [actual evidence](../quality/reviews/0008-kafka-foundation.md). This is a bounded phase-1 slice, with a separate exact-patch review before any implementation commit.

## Objective

Add a persistent local Kafka broker and explicit topic initialization to the existing Compose foundation. Verify transport storage and restart behavior using Kafka's own command-line tools. Application outbox publication, consumer admission, job execution, and worker readiness remain later implementation slices.

## Broker and network

Use the supported official Apache Kafka 4.4.0 JVM image, published in the [Apache release list](https://kafka.apache.org/downloads/), pinned to the public registry index digest `sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f`. The manifest includes Linux amd64 and arm64; Linux arm64 has since been executed in the implementation checks; amd64 remains unverified.

| Setting | Proposed value and boundary |
| --- | --- |
| Service | `kafka`, one combined KRaft broker/controller, node ID 1 |
| Cluster identity | Fixed documented non-secret local cluster ID, preserved with its metadata volume |
| Client listener | `kafka:9092`, plaintext on the existing internal backend network |
| Controller listener | `kafka:9093`, internal-only |
| Host publication | None for either listener |
| Persistence | Project-scoped named `kafka_data` volume at `/var/lib/kafka/data` |
| Process identity | Official image's non-root `appuser`; drop capabilities and enable no-new-privileges |
| Filesystem | Vendor startup requires writable generated configuration; do not claim read-only broker root filesystem |
| Initial resource budget | JVM heap 256–512 MiB, container memory limit 1 GiB; validate against actual startup before claiming adequacy |
| Shutdown | Up to 30 seconds before Docker termination escalation |
| Health | Bounded broker API query using bundled tooling, with startup grace and finite retries |
| Automatic topic creation | Disabled |
| Topic deletion | Disabled in the default lab configuration |

The official image supplies the [non-root user and data directories](https://github.com/apache/kafka/blob/4.4.0/docker/jvm/Dockerfile). Its [startup configuration script](https://github.com/apache/kafka/blob/4.4.0/docker/resources/common-scripts/configure) requires a writable configuration directory. Actual execution observations are recorded in the linked implementation review.

This is trusted local plaintext infrastructure, without hosted authentication/TLS/ACL or high-availability guarantees. One broker/controller and replication factor 1 do not tolerate host or disk failure.

## Topic initialization

Add a non-root one-shot `kafka-init` service using the same pinned Kafka distribution. It waits for broker health and operates only on repository-owned topic names. It uses a read-only root filesystem with narrowly scoped temporary filesystems for Java tools; no PostgreSQL credentials, raw demo credentials, or Docker socket are mounted.

| Topic | Partitions | Replication | Minimum ISR | Cleanup | Retention |
| --- | --- | --- | --- | --- | --- |
| `tickets.execution-requested.v1` | 3 | 1 | 1 | delete | 7 days |
| `tickets.execution-failed.v1` | 3 | 1 | 1 | delete | 7 days |

Creation is explicit and idempotent. Existing topics must match the partition count, replication, and configured retention/cleanup policy. A mismatch fails initialization; the job must not change partitions, alter incompatible topics, delete records, or recreate topics to repair it. Commands use finite request/API/process time bounds and safe completion/failure events.

The idle worker starts after existing identity seeding and successful topic initialization. The API keeps its existing PostgreSQL/Redis readiness boundary and does not acquire a Kafka startup dependency. A later broker outage must not make that API health check depend on Kafka.

Seven-day transport retention is a proposed local default, not a business-state retention policy. PostgreSQL remains the planned source of truth. Delayed admission beyond broker retention and authorized re-publication require the later outbox/recovery implementation; this slice does not prove those guarantees.

## Verification to implement

Use a uniquely named disposable Compose project and only its own volumes/topics/containers:

1. Build/start the broker and topic job; verify non-root identity, unpublished listeners, health, and expected topics/settings.
2. Repeat initialization and recreate containers while retaining named volumes; verify compatible topics remain usable.
3. Create a separate one-partition transport probe topic in that test installation, publish a fictional keyed record with all-replica acknowledgement, and consume it by explicit partition/offset with automatic offset commit disabled.
4. Stop/restart the broker and recreate its container; verify the probe record remains. While the broker is stopped, verify API readiness remains determined by PostgreSQL/Redis.
5. Attempt publication to an unknown topic with bounded synchronous failure; verify automatic creation remains disabled.
6. Deliberately increase a scheduling topic's partition count only in the disposable test installation. Verify initialization refuses it, preserves records/settings, and blocks a newly starting worker.
7. Check safe default broker/job logs and clean up only that test project's resources. Never prune Docker or reset a developer installation.
8. Run the existing fast, PostgreSQL, application-image, and Compose checks affected by the new startup dependency.

This section defines the approved verification scope; actual passing assertions and remaining limitations are recorded in the linked implementation review. Native producer/consumer tests establish only the tested broker/tool transport path. They do not establish consumer inbox transactions, manual committed offsets after database admission, deduplication, job execution, event schema validation, or exactly-once effects.

## JavaScript client gate

The accepted ADR requires KafkaJS compatibility and maintenance suitability to be reviewed before pinning it. Registry metadata checked on 2026-11-19 reports latest KafkaJS 2.2.4 and last modification on 2023-02-27. Release age alone is not a complete maintenance assessment, and no KafkaJS compatibility result is claimed.

This proposed broker slice installs no JavaScript Kafka client. Before application producer/consumer code, complete that review and either validate the baseline client or propose an explicit ADR revision. Using bundled Java tooling now does not waive that gate.

## Approval boundary

Explicit approval of this proposal authorizes preparing and verifying the described Kafka infrastructure slice. The resulting implementation diff, actual test results, dependency/image findings, and proposed commit message must still be reviewed under [AGENTS.md](../../AGENTS.md) before committing. No push, hosted deployment, SDK substitution, or deletion of existing development data is implied.
