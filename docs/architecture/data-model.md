# Relational model and transaction boundaries

Status: the published phases 2–4 implement identity, transactional submission/outbox, Kafka admission, owned execution, replay/audit and immutable cited retrieval. The working-tree phase-five additions below extend policy selection and atomically persist bounded agent evidence/results/summaries; see [acceptance evidence](../quality/phase5.md). Logical proposals without a corresponding implementation record remain design only. Read with the [overview](overview.md), [contracts](contracts.md), and [execution ADR](../adr/0001-durable-ai-execution.md).

## Conventions and ownership

Use UUID identifiers, UTC timestamps, explicit foreign keys, named uniqueness constraints, and bounded text/JSON fields. Timestamps involved in execution ownership come from the database, not worker clocks. Generation and attempt numbers are positive integers. Avoid database enums until migration tradeoffs are reviewed; statuses must still have explicit allowed-value constraints.

The API owns submission, replay, and reads. The consumer owns inbox admission and initial job scheduling. The executor owns attempts and results. The relay owns publication tracking. These are module boundaries within a shared database, not independent services with separate storage.

Tenant-bearing relationships include tenant identity in composite foreign keys. A globally unique UUID alone does not enforce tenant consistency. Tenant filters and authorization remain mandatory even with these constraints; database row-level security is a separate decision.

## Logical tables

| Table | Essential fields | Integrity rules |
| --- | --- | --- |
| `tenants` | `id`, `name`, `created_at` | Primary key `id` |
| `principals` | `id`, `tenant_id`, `role`, `disabled_at` | Tenant FK; unique `(tenant_id, id)`; roles resolve to server-owned permissions |
| `auth_credentials` | `id`, `principal_id`, `secret_digest`, `created_at`, `expires_at`, `revoked_at` | Principal FK; unique credential lookup ID; no raw bearer secret; provisioning and revocation follow the [security design](security.md) |
| `tickets` | `id`, `tenant_id`, `created_by`, `message`, `current_generation`, `created_at`, `updated_at` | Unique `(tenant_id, id)`; creator belongs to tenant; message meets validated length bounds |
| `ticket_executions` | `tenant_id`, `ticket_id`, `generation`, `status`, `scheduling_reason`, `requested_by`, `correlation_id`, `scheduling_event_id`, pinned corpus/profile/policy/provider references, timestamps | Primary key `(tenant_id, ticket_id, generation)`; tenant-consistent ticket and requester FKs; unique scheduling event ID |
| `idempotency_records` | `tenant_id`, `operation`, `resource_scope`, `key`, `request_hash`, `ticket_id`, `generation`, `receipt`, `created_at` | Unique `(tenant_id, operation, resource_scope, key)`; tenant-consistent execution FK; immutable successful receipt |
| `outbox_events` | `event_id`, `tenant_id`, `ticket_id`, `generation`, `type`, `version`, `payload`, `payload_digest`, `created_at`, publication fields | Primary key `event_id`; execution FK; payload bounded by event contract; immutable event content |
| `consumer_inbox` | `consumer_name`, `event_id`, `payload_digest`, `tenant_id`, `ticket_id`, `generation`, `disposition`, `received_at` | Unique `(consumer_name, event_id)`; execution FK for admitted ticket events; disposition is scheduled, duplicate-generation, or stale |
| `execution_jobs` | `id`, `tenant_id`, `ticket_id`, `generation`, `status`, `available_at`, `attempt_count`, `max_attempts`, admitted `source_event_id`, lease fields | Unique `(ticket_id, generation)`; execution FK; nonnegative count and positive maximum; one current ownership token |
| `execution_attempts` | `id`, `job_id`, `attempt_number`, `status`, `started_at`, `finished_at`, `failure_code` | Unique `(job_id, attempt_number)`; attempt ID is the ownership token; records are preserved after lease expiry |
| `execution_results` | execution key, `outcome`, `answer`, `provider_mode`, safe execution summary, `created_at` | One result per execution; execution FK; bounded content and allowed outcomes |
| `result_citations` | execution key, citation position, `tenant_id`, `document_id`, `document_version`, `chunk_id` | Unique position per result; same-tenant result and chunk FKs; no dangling version references |
| `event_quarantine` | `consumer_name`, `topic`, `partition`, `offset`, `payload_digest`, safe reason, `created_at` | Unique source position per consumer; no FK requiring invalid producer-supplied tenant or ticket IDs |
| `audit_records` | `id`, `tenant_id`, `principal_id`, `ticket_id`, `generation`, `action`, `request_id`, `created_at` | Tenant-consistent principal/execution FKs; no credentials or raw model content |

`ticket_executions` is the authoritative lifecycle state for each generation. `tickets.current_generation` is a pointer, not a duplicate status field. Enforce its composite relationship to an execution at transaction commit, allowing ticket and first execution creation in the same transaction. The concrete deferred-constraint migration must be verified with integration tests before adoption.

Jobs retain terminal states. Repeated scheduling cannot create a replacement merely because the original job completed. Results and earlier generations remain available internally even though the initial public GET exposes only the current generation.

## Documents and citations

| Table | Responsibility and constraints |
| --- | --- |
| `documents` | Tenant-owned logical document identity; unique `(tenant_id, id)` |
| `document_versions` | Immutable source snapshot, content digest, and ingestion metadata; unique `(tenant_id, document_id, version)` |
| `document_chunks` | Immutable chunk content and position; FK to document version; unique position within that version and a tenant-consistent chunk identity |
| `corpus_snapshots` | Tenant-owned immutable manifest identity/digest; unique `(tenant_id, id)` |
| `corpus_snapshot_documents` | Same-tenant snapshot membership referencing immutable document versions; unique snapshot/document/version |
| `tenant_corpus_profiles` | Active snapshot/retrieval profile per tenant; only validated ready snapshots can be selected |
| `chunk_embeddings` | Chunk identity, embedding profile, vector, and creation time; unique chunk/profile pair |

An embedding profile identifies model, dimension, preprocessing version, and distance configuration. Never compare embeddings from incompatible profiles. The [AI design](ai-system.md) defines offline dimensions/chunking, exact retrieval, and active-corpus selection; a real embedding profile requires a compatible dimensional storage path. A simulated provider must not be presented as a meaningful semantic retrieval benchmark.

A result cites immutable versions, not whatever text is currently active. Referenced versions cannot be hard-deleted while results depend on them. Creating an answered result and at least one valid citation is an application transaction invariant; an ordinary row-level constraint alone does not prove that a child citation exists. Test this boundary explicitly. Abstention stores no citations.

## Transaction protocols

### Submission

1. Validate/authenticate and derive tenant scope before mutation.
2. Reserve the unique idempotency identity inside the same transaction as the ticket; no committed pending placeholder is exposed.
3. Create ticket, generation 1 execution, immutable receipt, and scheduling outbox record.
4. Commit all or none. On uniqueness contention, obtain the winning receipt in a valid transaction and compare its hash.

A rolled-back winner does not reserve the key. A lost HTTP response does not justify creating a second ticket. Canonicalization and receipt behavior follow the HTTP contract.

### Event admission

1. Validate the envelope and digest; quarantine invalid input durably without trusting its tenant fields.
2. Resolve the authoritative tenant/ticket/execution and serialize against replay using the ticket lock.
3. Check inbox identity and digest; a changed payload with an existing event ID is quarantined by source position.
4. Record disposition and insert a job if the generation is current and no job exists.
5. Commit before advancing the partition's contiguous durable offset.

Unknown or future executions and tenant mismatches are quarantined. A valid older generation is recorded as stale. A second valid event for a current execution with an existing job records duplicate-generation disposition. No network acknowledgement occurs inside a database transaction.

### Claim, renew, and complete

Candidate discovery does not establish ownership. In a short transaction, lock the ticket before the execution/job, recheck eligibility, and claim only a current-generation available job or an expired lease. Use one consistent lock order for all operations touching these rows.

Each claim increments the durable attempt count and inserts a new attempt token. Reclaiming an expired lease also closes the previous attempt as expired in that transaction. Lease fields include `attempt_id` and `lease_expires_at`; a running job must have both, and a non-running job must have neither. `attempt_count` cannot exceed its stored maximum. An expired attempt consumes its budget even if it never persisted an error.

Renewal requires current generation, attempt token, running state, and an unexpired lease checked with database time. A late heartbeat cannot resurrect ownership. External calls occur after the claim transaction commits.

Completion locks the same authoritative rows and checks the current generation, token, running state, and unexpired lease at the conditional write. It writes result/citations, finishes the attempt/job, and updates execution status together. Lease validity is checked when ownership is validated under lock, not claimed as a real-time guarantee about the eventual commit timestamp. A competing claim cannot take ownership through these locks during the transaction.

A stale worker gets a rejected ownership result and must discard its response rather than retrying persistence with a new token. It may still have incurred an external call or charge.

### Retry and terminal failure

A retryable failure from the current attempt finishes the attempt, clears the lease, sets future eligibility, and returns the execution to queued in one transaction. A permanent failure or budget exhaustion instead marks job/execution failed and creates a sanitized failure notification in the outbox.

Recovery handles expired jobs with the same lock order. If the attempt budget is already exhausted, it closes the expired attempt and performs terminal failure atomically instead of starting another call. Failure-finalization must be safe to repeat, producing one terminal notification per execution. Use a unique logical notification identity `(ticket_id, generation, type)` for terminal failure notifications. Scheduling events may have distinct repair identities; the scoped repair receipt prevents duplicate repairs without forbidding an explicit replacement delivery.

A database outage cannot be recorded reliably as an attempt result during the outage. On recovery, inspect committed lease and attempt state; do not assume a failed client response proves a rollback. Never acknowledge unpersisted event handling or fabricate a successful result.

### Replay

After authorization and tenant lookup, check a matching idempotency receipt first. For a new key, lock the ticket, verify failed state at the expected generation, and create the next execution, receipt, audit record, and scheduling outbox record while advancing the pointer atomically.

Competing replay keys serialize on the ticket and one conflicts on expected generation. Old jobs cannot update the current execution through a stale worker. Preserve their final records and do not recycle attempt tokens or event IDs.

### Outbox publication

Claim a bounded batch with a publication token and lease in a short transaction. Publish outside the transaction. Mark a row published only if broker acknowledgement was received and the claim token still matches. Expired claims are reclaimable; an old relay cannot mark a newer claim completed.

Outbox rows have publication eligibility, claim expiry, attempt count, last safe error, and published timestamp. An outage leaves them pending with bounded retry delay. Batch concurrency may reorder publication; partition keys alone do not recover original transaction order. Current scheduling logic therefore relies on generation checks, not assumed relay order.

## Initial access paths

Index design must be validated against the actual queries and seeded workload; these are intended access paths, not performance claims:

- Tenant-scoped ticket lookup and current execution lookup through unique keys.
- Idempotency lookup through its scoped uniqueness key.
- Inbox lookup through consumer/event identity.
- Eligible queued jobs ordered by availability and ID, with bounded batch size.
- Expired running jobs ordered by lease expiry and ID.
- Pending outbox rows ordered by eligibility and ID; separately locate expired publication claims.
- Attempts by job and attempt number; audit records by tenant/ticket and creation time.
- Quarantine inspection by reason and creation time; source-position uniqueness prevents repeated records.
- Chunks/embeddings by tenant, immutable version, and embedding profile before retrieval indexing is selected.

Use targeted indexes for pending/running work rather than scanning historical terminal rows. Record query plans during integration work before adding broader indexes or claiming throughput.

## Retention and reset

No automated business-data retention or hard deletion is included in the local demo. Preserve idempotency receipts, inbox records, terminal jobs, execution history, and referenced documents so duplicate handling and citations remain explainable. A full explicit demo reset removes related data consistently.

Quarantine stores digests and safe metadata by default, not unbounded raw messages. It is an inspection record, not an automatic replay source. Correct an invalid producer and use an authorized recovery workflow; authorized same-generation recovery follows the [delivery-repair contract](../operations/recovery.md).

Model retention is a local-demo simplification. Production retention, privacy deletion, storage growth limits, and restricted diagnostic payload storage require separate decisions.

## TDD acceptance additions

- DATA-01: rollback at each submission write leaves no partial ticket, receipt, or event.
- DATA-02: cross-tenant composite references are rejected by constraints.
- DATA-03: concurrent claims yield one active attempt token for a job.
- DATA-04: expired ownership cannot renew or persist results; a new attempt can finish.
- DATA-05: retries and crashed attempts exhaust the stored budget without another external call after exhaustion.
- DATA-06: a completion rollback leaves no partial result, citations, or completed status.
- DATA-07: replay and stale admission/completion races preserve one current generation.
- DATA-08: a referenced document version cannot disappear while a result cites it.
- DATA-09: repeated failure-finalization and relay recovery do not duplicate logical terminal effects.
- DATA-10: after ambiguous commit acknowledgement, retry observes committed state without fabricating another claim or effect.

The [phase-2 gate](../quality/phase2.md) verifies DATA-01 through DATA-04 using real PostgreSQL. Remaining families require their own recorded evidence and are not implied by phase-2 closure. Exact column types, migrations, ownership predicates, bounded result sizes, and deadlock handling must be reviewed with the implementation patch. Authentication provisioning and threat analysis are specified in the [security proposal](security.md); application scaffolding remains gated.


## Replay persistence boundary

[Review 0022](../quality/reviews/0022-ticket-replay-batch.md) adds the ninth migration and atomic replay operation. A new failed-to-queued generation is separate from the immutable old execution/job/attempt/failure history. The transaction takes the tenant-scoped ticket lock before receipt or lifecycle checks, then inserts a new execution, scheduling outbox, scoped receipt and audit record and advances the current-generation pointer. Every lifecycle writer already takes this same ticket lock first, so the API needs no UPDATE permission on old execution rows.

`audit_records` contains only identity/action/request metadata, with tenant-consistent principal and old/new execution FKs, consecutive generation checks and one replay audit per generation. API grants permit audit INSERT and only `tickets.current_generation/updated_at` UPDATE; audit UPDATE/DELETE, ticket-content changes and worker-role escalation are not granted. The API role remains a trusted module identity; this is not RLS or database-enforced forward-only lifecycle policy for a compromised API.


## Optional phase-2 trace origins

The tenth migration adds nullable `trace_parent` metadata to outbox events and execution jobs, with canonical version-00/nonzero-ID constraints and insert-only runtime grants. Context is validated or dropped before persistence. Outbox payload, digest, event identity and scoped request hash remain unchanged; duplicate delivery/requests retain the original metadata. Existing rows stay null and readable after upgrade. The durable origins permit worker-process restarts without losing the normal trace chain; missing metadata never grants access or blocks valid scheduling. See [trace correlation](../operations/trace-correlation.md).


## Phase-4 implemented provenance

Migrations 13–14 add the owned immutable corpus/profile/snapshot model and `execution_configurations`, `execution_evidence`, and `result_citations`. A new accepted generation pins snapshot/profile/policy/provider in its transaction. Retries retain the row; replay selects the current active configuration. Legacy executions without this row preserve original abstention behavior.

Attempt evidence binds current job/attempt, immutable chunk/version, snapshot membership and embedding profile through composite foreign keys. Completion admits only actually delivered references; answer, citations and lifecycle commit together. Deferred checks require citations for answered results and prohibit them for abstention. Earlier versions and evidence remain referenced. See [scope and role details](../operations/knowledge.md) and [actual acceptance](../quality/phase4.md). These changes do not add public ingestion, tenant RLS or an answer cache.

## Phase-five bounded agent results

Migration 15 admits both `extractive-simulated-v1` and `bounded-agent-v1` configuration policies. It does not rewrite accepted configurations or existing results. Fixed seed activation advances the active tenant policy for subsequent acceptance/replay; downgrade or snapshot rewind is rejected. Retries preserve the original configuration.

`execution_results.agent_summary` is nullable for legacy/extractive results. New bounded-agent results require a strict summary containing policy, simulated provider mode, one to four model turns and at most three serial tool names/outcomes, capped at 4 KiB. A database predicate rejects extra fields, invalid types/names and inconsistent counters; a deferred policy check requires a summary exactly for bounded-agent configurations. Worker INSERT and API SELECT grants add this column without adding a role or login.

Agent responses retain evidence in bounded process memory. Completion locks the ticket/job, verifies current generation/token/lease, validates pinned context, inserts exact immutable evidence, checks citations and commits result/summary/lifecycle in the same transaction. Failed validation or SQL rolls back every new row. A killed response leaves no partial agent evidence/result; recovery can repeat read-only work under a new attempt. See [phase-five acceptance](../quality/phase5.md).
