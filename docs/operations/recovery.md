# Recovery runbooks

Status: proposed procedures. Operational commands and fault checkpoints do not exist yet. Implement and verify each procedure before presenting it as a runnable recovery guide.

## General procedure

Record revision, local project identity, ticket/generation, safe error code, and relevant trace IDs. Inspect persisted state before retrying after an ambiguous error. Restore dependencies before making business-state changes. Never edit rows ad hoc, rewind shared offsets blindly, or delete volumes as ordinary recovery.

Host operations have a separate allowlisted entry point and database role; they are not business CLI commands or AI tools. Before a mutating operational action, show the project, tenant, execution, expected state, and intended effect, then require operator confirmation. Audit the operation and its reason.

## Symptom-driven recovery

| Symptom | Inspect | Safe action | Proof of recovery |
| --- | --- | --- | --- |
| Ticket queued, outbox pending | Broker connectivity, relay lease, publication age | Restore broker/relay; allow expired claim recovery | Outbox published, one durable job, eventual result |
| Event published, no job | Consumer group, quarantine, schema/tenant checks | Restore consumer; inspect a quarantined source before any repair | Valid event admitted once; no skipped offsets |
| Job running after worker loss | Attempt token, expiry, budget | Restart executor and allow lease recovery | New token owns work; old result cannot overwrite |
| Retry budget exhausted | Safe failure code and attempt history | Fix cause, then authorized expected-generation replay | One new generation, preserved old history, new receipt |
| Redis unavailable | Limiter dependency and 503 rate | Restore Redis; retry mutations with their original key | No fail-open access or duplicate tickets |
| PostgreSQL unavailable | Connectivity and transaction outcome after restoration | Restore service; reread idempotency/job identity | Durable state determines recovery, not client error alone |
| Telemetry unavailable | Export queue/error counters | Restore Collector/backend; do not replay completed tickets | Business data unchanged; new signals exported |
| Credential file missing | Existing database identity/digest and volume state | Stop and perform reviewed reprovisioning or an explicit full demo reset | Valid identities work; previous credentials cannot be misattributed |

## Quarantine inspection and repair

Quarantine is a safe record of invalid input, not a replay queue of trusted payloads. Inspect topic/partition/offset, digest, safe reason, current authoritative execution, and whether a valid job already exists. Raw messages are not exposed in business APIs or normal logs. Never trust tenant or resource IDs taken only from malformed input.

Define a dedicated operator repair operation for a valid current queued execution with no job: it requires explicit tenant/ticket/generation, expected current scheduling event ID, reason, and a stable repair idempotency key. Lock the ticket and verify all expectations. Reject if work is already scheduled, the generation changed, or the execution is not queued.

Build a fresh canonical scheduling event from authoritative execution records, not quarantined bytes. Atomically write a new immutable outbox event, advance the execution's active scheduling-event reference, persist the repair receipt, and audit old/new IDs. Preserve all old outbox and quarantine records. A repeated repair key returns its original receipt without another event. Existing old events may still arrive; inbox/job uniqueness prevents duplicate work. The failure notification causation uses the event that actually scheduled the job, recorded at admission.

This is delivery repair within the same generation, distinct from replay of a failed execution. It does not reset an attempt budget, bypass Kafka, change documents, or mark work completed. Non-current/unknown executions are inspected and left quarantined; do not create tickets from them.

The operator interface, permission grants, audit actor representation, and receipt persistence need explicit implementation review. Store repair receipts in the scoped idempotency mechanism using a distinct operation version; do not reuse submission/replay scope. No hidden automatic repair runs at startup.

## Shutdown and upgrades

Stop new claims and readiness, drain within the configured budget, and let interrupted jobs recover through leases. Before upgrading a persisted demo, test migrations from the previous release against an isolated copy. Do not assume reverting an image reverses a schema migration. Restore from a verified backup or roll forward under an explicit operator plan when necessary.

## Recovery acceptance additions

- REC-01: broker outage preserves pending outbox and resumes without duplicate jobs.
- REC-02: stopped executor recovers through lease expiry and rejects stale completion.
- REC-03: terminal replay requires the right role/generation and preserves prior history.
- REC-04: quarantine repair rebuilds only from authoritative current state, audits IDs, and is idempotent.
- REC-05: late pre-repair events cannot create a second job or corrupt failure causation.
- REC-06: wrong-project or stale-expectation operational mutations are rejected before changes.

Evidence includes states before/after, observed assertions, bounded elapsed time, and safe cleanup. A container restart alone is not proof that the intended failure window was exercised.
