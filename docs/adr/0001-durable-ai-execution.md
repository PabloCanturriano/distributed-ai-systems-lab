# ADR-0001: Separate event delivery from durable AI execution

Status: accepted as the architecture baseline on 2026-11-16. Implementation and compatibility evidence remain required.

## Context

Ticket execution includes network calls with variable latency and partial failures. A process can stop after a model responds but before its answer is persisted. Kafka delivery and database transactions do not make these external calls atomic.

The local system needs reproducible recovery without holding a database transaction or coupling a long-running model call to Kafka consumer liveness.

## Decision

Use Kafka to deliver committed ticket events and PostgreSQL to manage durable execution after delivery.

1. Submission writes the ticket and outbox record in one transaction.
2. The relay publishes the event and marks it published after broker acknowledgement.
3. The consumer records its inbox entry and schedules a job in one transaction. It acknowledges the Kafka offset only after that transaction commits.
4. An executor claims the job with a bounded database lease and runs external calls outside transactions.
5. Result persistence is conditional on the current ticket generation, attempt token, and unexpired lease. The result, terminal job state, and ticket state commit together.

Inbox uniqueness is scoped to consumer and event ID. Job uniqueness is scoped to ticket and execution generation. Only consumer-scheduled jobs are executable; the executor does not scan queued tickets as an alternative to Kafka delivery.

Kafka offsets must advance only through contiguous records whose handling is durable within each partition. Acknowledging a later record must not skip an earlier unpersisted record.

## Retry ownership

| Stage | Recovery owner | Completion boundary |
| --- | --- | --- |
| Outbox publication | Relay | Broker acknowledgement followed by publication marking |
| Event delivery | Kafka consumer | Durable inbox entry and job, or durable quarantine for invalid input |
| AI execution | Database-backed executor | Conditional result commit or durable terminal failure |

Retryable execution failures update durable eligibility time and consume an attempt budget. Crashed attempts also count toward that budget. Exhaustion marks the ticket failed and creates a dead-letter outbox record atomically. Infrastructure outages must preserve pending work and expose its age; an outage alone must not discard an outbox record or a valid unscheduled event.

Authorized replay creates a new generation and outbox event with an audit record. It does not delete earlier attempts or reset the meaning of their event IDs.

## Failure windows

| Failure | Expected recovery |
| --- | --- |
| Submission transaction rolls back | Neither ticket nor event is committed |
| API response is lost after commit | Reusing the submission key returns the existing ticket |
| Relay stops before publication | Pending outbox record is published later |
| Relay stops after publication but before marking | Event may repeat; inbox and job constraints suppress duplicate scheduling |
| Consumer stops after scheduling but before offset commit | Redelivery observes the durable inbox entry |
| Executor stops during execution | Lease expiry allows a bounded recovery attempt |
| External call succeeds but result is not persisted | Call may repeat; duplicate external cost remains possible |
| Old attempt returns after lease loss | Conditional persistence rejects its result |
| Old generation event arrives after replay | It cannot schedule execution for the new generation |

Execution is at least once. The guarantee is idempotent committed business effects, not exactly-once external invocation. Use provider idempotency support where available, but do not assume it exists or covers all tools.

## Alternatives considered

### Execute the model call inside the Kafka handler

Fewer scheduling components, but long calls complicate consumer liveness, rebalances, and recovery. External-call duplication still exists. Rejected for this design because execution recovery and budgets are explicit learning goals.

### Use PostgreSQL as the only queue

Simpler for this workload and a reasonable choice without a Kafka requirement. Rejected here because the agreed scope includes event transport, consumer deduplication, and outbox publication as observable parts of the system. This choice is educational, not a claim that Kafka is necessary at the expected demo volume.

### Add another job queue

Would provide job scheduling capabilities but introduce another execution authority and operational dependency. Rejected while PostgreSQL can support the bounded local workload.

## Consequences

The design adds jobs, leases, heartbeat logic, and a recovery loop. Tests must cover concurrency and crashes, not merely successful execution. PostgreSQL becomes responsible for scheduling availability after delivery. Kafka remains responsible for reaching that durable handoff.

Per-ticket partitioning does not establish total ordering across topics or prevent stale attempts. Generation checks and conditional writes remain necessary. A worker may continue an already-started external call after losing its lease; read-only tools limit side effects but do not eliminate cost or data exposure risks.

Proposed [runtime limits](../architecture/runtime-limits.md), [contracts](../architecture/contracts.md), [data model](../architecture/data-model.md), and [security boundaries](../architecture/security.md) make leases, budgets, quarantine, and replay explicit. They still require implementation and integration evidence.

## Verification required

Reproduce every failure window above. Verify concurrent consumers create one job per generation, stale workers cannot write results, and a committed job survives Kafka or worker restarts. Report observed external-call duplication separately from database deduplication.

See [the architecture overview](../architecture/overview.md) for component boundaries and the remaining design gate.
