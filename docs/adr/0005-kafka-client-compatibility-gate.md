# ADR-0005: Evaluate the Confluent JavaScript client before application messaging

Status: proposed on 2026-11-19; awaiting owner architecture review. ADR-0002 remains the accepted baseline until this proposal is approved. No dependency substitution is implemented.

## Context

The persistent Kafka 4.4.0 broker is implemented, but the application has no producer or consumer. ADR-0002 requires maintenance and compatibility evidence before pinning KafkaJS. The [client review](../quality/reviews/0009-kafka-client-selection.md) records current metadata and concludes that the old stable release leaves an unresolved maintenance risk; no technical incompatibility has been proven.

Confluent's client has a more recent stable release and documented Node 24 support, with additional native packaging costs. Changing the adapter's SDK warrants explicit architecture review rather than a silent dependency substitution.

## Proposed decision

Authorize a bounded compatibility slice evaluating `@confluentinc/kafka-javascript` 1.11.0 with its promisified API against the existing pinned Apache Kafka 4.4.0 and Node 24.22.3/Bookworm runtime. Recheck versions and advisories before resolving the experimental lockfile; any different candidate version must be explained in its review.

Keep SDK types/configuration internal to a narrow messaging boundary. Preserve PostgreSQL as business source of truth, at-least-once delivery, sequential handling within each partition, and explicit offset commits after durable admission. An SDK's idempotent producer does not make the SQL/Kafka boundary or external effects exactly once.

This approval would authorize preparing and verifying only the compatibility package/test harness and its necessary isolated build inputs. It does not authorize business application wiring or an implementation commit. After evidence review, document whether the candidate passed and retain or reopen this choice before implementing producer/consumer behavior.

## Bounded implementation and acceptance plan

Use only a uniquely named disposable broker installation and fictional records. Do not alter existing developer topics, credentials or data. Do not change default API readiness or turn the idle worker into an unreviewed consumer.

1. Resolve an exact candidate lockfile and dependency audit; inspect package/native licenses and installation inputs. Record native binary origin, platform, ABI, cryptographic checksum and actual librdkafka version. Preserve global `--ignore-scripts`; allow only explicit reviewed native preparation in the build stage. Fail if no reviewed platform artifact/build path is available.
2. Build and load the client in the pinned Node 24/Bookworm Linux arm64 image under its non-root, restricted runtime. Keep compilers and initialization tools out of runtime. Declare amd64 and host-platform results separately; do not infer a tested matrix from advertised support.
3. Connect and publish keyed records with all-replica acknowledgement and automatic topic creation disabled. Verify order within the selected partition and bounded failure for unknown topics/unavailable broker. Inspect delivery results; do not treat enqueue success as broker acknowledgement.
4. Join a real consumer group with automatic commits disabled. Use explicit test checkpoints and independent committed-offset inspection to prove an unfinished handler does not advance the group's offset, including normal disconnect and partition revocation.
5. Kill a consumer before manual commit and verify the same group redelivers that record. Explicitly commit the next offset, restart, and verify consumption resumes there. Preserve offsets as decimal strings with precision-safe increment. These are transport checkpoints, not SQL admission transactions.
6. Trigger a two-consumer rebalance while one handler is blocked. Verify no unsafe offset advance, bounded shutdown, and sequential handling within a partition. An unfinished record may be redelivered; future database deduplication remains required. Measure outage/reconnection bounds and use an outer test deadline rather than arbitrary race-winning sleeps.
7. Verify safe logs exclude fictional payloads and injected test secrets; clean up only the test installation. Rerun affected formatting, type/build and application-image checks, then report exact successes, failures and unsupported platforms.

If native preparation, manual-commit semantics, security review or bounded recovery fails, stop adoption and report the failing gate. Do not suppress findings or weaken acceptance criteria to obtain a passing result.

## Alternatives and consequences

Retaining KafkaJS preserves a pure-JavaScript, dependency-free runtime package and the original choice. It still needs a comparable compatibility investigation and explicit acceptance of maintenance uncertainty. A passing smoke test would not resolve ongoing maintenance by itself.

Confluent's client adds native artifacts, installation provenance and transitive dependency management. Its published Node/platform coverage is promising but must be reproduced for this lab. No hosted Confluent service, paid account, Schema Registry or external credential is required by the proposed local experiment.

Changing the broker version, implementing Kafka protocol support ourselves, or bypassing transport would introduce unnecessary scope and does not resolve the current evidence gate.

## Approval and evidence boundary

The owner must approve this proposed client-selection change before code, dependencies or runtime configuration for the alternative client are prepared, under [AGENTS.md](../../AGENTS.md): “Do not introduce application code, scaffolding, dependencies, or runtime configuration until the owner has reviewed and approved the architecture.”

Approval authorizes the bounded preparation described above. The complete implementation patch, actual checks, findings and proposed commit message still require separate exact-patch approval. Push/merge/release authorization remains separate.
