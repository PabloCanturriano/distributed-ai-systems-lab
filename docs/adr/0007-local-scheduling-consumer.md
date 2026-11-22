# ADR-0007: Integrate the native client with durable scheduling admission

Status: bounded native-consumer architecture explicitly approved by the owner on 2026-11-20. The exact implementation was approved, committed as `df155ba` and pushed; [review 0017](../quality/reviews/0017-local-scheduling-consumer.md) records evidence. ADR-0006 adopted the SDK only for publication; this approval extends it to the consumer described here.

## Context and decision

[ADR-0001](0001-durable-ai-execution.md) approves the inbox/job handoff. Its [SQL implementation](../quality/reviews/0016-scheduling-admission.md) prepares durable admission independently of broker callbacks. The remaining client choice is to extend `@confluentinc/kafka-javascript` 1.11.0 to a local consumer, using the already pinned native artifacts and the promisified API. Recheck metadata/advisories before implementation; a changed candidate requires review.

## Approved bounded implementation

- Add a separate worker scheduling-consumer entry point and an opt-in service under the existing `messaging` profile. Keep the default worker idle and leave API readiness unchanged. Use only its read-only worker-password volume, `lab_worker_login`/`lab_worker`, non-root/read-only execution, dropped capabilities and the backend network. No host ports, Docker socket, raw demo credentials or new public API.
- Subscribe only to `tickets.execution-requested.v1`, with stable group ID `lab-ticket-scheduler-v1` and database consumer identity `ticket-scheduler.v1`. Disable automatic commits. Start with one callback in flight across partitions and bounded fetch/cache settings; do not run an executor in the callback.
- Pass exact key/value bytes and trustworthy source metadata into admission. Commit the explicit next offset only after its database transaction resolves. A failed or ambiguous database/offset acknowledgement blocks advancement past that record; redelivery observes inbox/job uniqueness or durable quarantine. No later callback may skip an unresolved earlier record in the same partition.
- Use the SDK's supported configuration path. Its promisified implementation manages offset storage internally and rejects a user-supplied `enable.auto.offset.store`; disabling automatic commits does not mean that arbitrary native options are supported. Verify actual run, failure, rebalance and disconnect behavior with the pinned SDK rather than assuming KafkaJS parity.
- The current native implementation also uses JavaScript numbers internally for offsets. Fail closed before admission/commit when an offset cannot be represented safely; do not round it or invent a quarantine source identity. The SQL boundary supports exact signed-64-bit offset strings, which alone does not establish SDK precision beyond safe integers.
- Stop callbacks/claims on shutdown, drain bounded SQL work within 15 seconds and leave uncertain offsets uncommitted. Use finite database/connection/shutdown bounds and fixed safe logs. No callback error may expose raw event bytes, credentials or SQL details.

## Required evidence and exclusions

Verify authenticated HTTP -> relay -> real Kafka consumer -> one durable job, with independent broker group-offset and PostgreSQL inspection. Cover identical and distinct event identities for one generation, invalid-record quarantine, PostgreSQL outage blocking later same-partition commits, crash after SQL commit before offset commit, rebalance/redelivery and shutdown. Exercise the application adapter on arm64 and amd64; label emulation separately. Confirm captured logs and mounts preserve the existing credential boundary.

This decision includes no job executor, result/AI generation, replay/repair, telemetry platform, hosted deployment, TLS/ACL rollout, release or exactly-once claim. Tickets remain queued until an independently reviewed executor exists. Native/OS inventory and scanning gaps remain open release gates.

Owner architecture approval permits preparing/testing this consumer adapter. Its exact implementation patch still needs separate commit approval under [AGENTS.md](../../AGENTS.md), and neither approval authorizes push or release.
