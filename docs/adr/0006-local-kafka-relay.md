# ADR-0006: Integrate the evaluated client into an opt-in local outbox relay

Status: proposed for owner architecture review on 2026-11-20. No application Kafka dependency, adapter, service or polling loop is introduced by this document. ADR-0005 authorized only the experiment; approval of its test patch did not adopt the SDK in applications.

## Context and proposed decision

The [Confluent client experiment](../quality/reviews/0010-kafka-client-compatibility.md) passed its Linux arm64 transport cases. The [outbox protocol](../quality/reviews/0014-outbox-publication.md) now supplies database-owned claims and acknowledgement fencing. Connecting those pieces requires approving the application client choice deferred by ADR-0002/0005.

Propose `@confluentinc/kafka-javascript` 1.11.0 behind the existing `OutboxPublisher` interface for a trusted local publisher only. This replaces the KafkaJS choice for that adapter, not its at-least-once semantics. Recheck releases/advisories before installation; a changed candidate version requires explicit review. The native/OS inventory and scanning gaps from the experiment remain open release gates, not a security-clean adoption claim.

## Bounded next implementation

- Add a separate relay entry point inside `apps/worker`; keep the current idle worker default. An opt-in Compose `messaging` profile starts a non-root, read-only relay container on the backend network, with no published ports, Docker socket or raw demo credentials. It mounts only its existing read-only relay-password volume and selects `lab_relay`. Seed completion and verified topics gate startup. API readiness retains its PostgreSQL/Redis boundary.
- Resolve the native package in a lockfile with all lifecycle hooks disabled. Explicitly download/verify the fixed official Node-ABI-137 Linux-glibc artifacts for arm64 and amd64 in a build stage. Preserve notices and record checksums/actual librdkafka versions. No compiler or uncontrolled source-build fallback enters runtime. Both runtime images must load and execute the selected adapter before claiming both architectures supported; emulated execution is labeled separately. If a reviewed artifact/path is unavailable, stop and report it rather than break the existing default images.
- Publish exact stored payload bytes with ticket ID as key, stable event ID, fixed topic mapping, all-replica acknowledgements and automatic topic creation disabled. Resolve the port only after delivery acknowledgement. Keep the 10-second complete operation bound; abort is best effort and does not establish that a timed-out request was never accepted by the broker.
- Poll bounded batches without holding SQL transactions during network calls. Preserve the database-time 30-second lease, stale-token guards and retry eligibility. Shutdown stops new claims, interrupts/drains bounded work within the existing 15-second policy and leaves uncertain/unstarted work recoverable. Do not advance a ticket's lifecycle because a message was published.
- Verify a real authenticated HTTP submission reaches Kafka through the relay, then inspect key/event ID/exact bytes with independent broker tooling and publication metadata in PostgreSQL. Stop/restart Kafka and crash after acknowledgement before SQL marking to demonstrate retained pending work and possible duplicate delivery with stable identity. Run affected image/Compose/client checks and log-secret assertions.

No consumer/inbox, job executor, result generation, replay, hosted deployment, TLS/ACL rollout, release or exactly-once effects are included. No direct database scheduling bypass substitutes for Kafka. The optional profile is an explicit local rollout boundary, not the completed one-command ticket demo.

## Approval boundary

Owner approval authorizes preparing and verifying this bounded application-client integration. Its exact implementation patch still needs separate commit approval, and push/release permission is separate. Until approval, [ADR-0005](0005-kafka-client-compatibility-gate.md) continues to exclude application SDK wiring under [AGENTS.md](../../AGENTS.md).
