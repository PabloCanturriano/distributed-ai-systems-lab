# Architecture proposal

Status: proposed. This document does not authorize implementation.

## Purpose and constraints

Process technical support tickets asynchronously and produce answers grounded in a fictional document corpus. The default environment must run locally through Docker Compose, require no external AI credentials, and support inspection through a CLI, HTTP API, and telemetry.

The initial design prioritizes reproducible failure behavior. It makes no production-readiness, high-availability, or measured scalability claim.

## Components

| Component | Responsibility |
| --- | --- |
| API | Authentication, tenant authorization, validation, ticket submission, result reads, and authorized replay |
| Worker | Event consumption, durable job scheduling, execution, retrieval, and bounded read-only tool calls |
| Outbox relay | Publish committed records to Kafka; mark publication after broker acknowledgement |
| CLI | Consume the API, poll with a deadline, and report demo outcomes with meaningful exit codes |
| PostgreSQL | Durable business state, outbox, consumer inbox, jobs, documents, and audit records |
| Kafka | At-least-once event transport; ticket ID is the partition key |
| Redis | Rate limiting and disposable cache data |
| OpenTelemetry services | Correlated traces and metrics; failures must not prevent business commits |

The API and worker are the two application services. Consumer, executor, and relay are worker roles and may run in separate processes using the same image. The CLI is an on-demand client, not another business service.

A shared PostgreSQL database deliberately simplifies local operation. Modules own their writes through explicit operations; this is not independent microservice data ownership. Redis is never the sole store for deduplication, authorization, or execution leases.

## Main flow

1. The API authenticates a tenant member and validates the submission and idempotency key.
2. One transaction creates the ticket, submission-key record, and outbox event. The API returns `202 Accepted` with the ticket ID and status URL.
3. The relay publishes the event. A crash after publication but before marking it published may produce a duplicate.
4. The consumer validates the event and atomically records its inbox identity and creates a job for the ticket generation. Only then does it commit the Kafka offset.
5. The executor claims an eligible job with a database lease, retrieves tenant-scoped context, and runs the bounded agent outside a database transaction.
6. One transaction stores the answer and references, completes the job, and marks the ticket completed, conditional on the current generation and attempt still owning an unexpired lease.
7. The CLI polls the API until completion, failure, or its own deadline. A client timeout does not cancel durable work.

A queued ticket alone is not executable: the consumer must first create its job. Kafka therefore remains part of the processing path. After scheduling, PostgreSQL owns retries and recovery; Kafka is not a second retry scheduler.

## State, concurrency, and recovery

Public ticket states are `queued`, `processing`, `completed`, and `failed`. Submission starts at `queued`. A claim moves to `processing`; a retryable failure returns to `queued` with a future eligibility time. Success completes the ticket. Permanent failure or an exhausted budget marks it failed.

A ticket has an execution generation; each claim has a new attempt token and lease expiry. Atomic claims and uniqueness on `(ticket_id, generation)` prevent duplicate jobs. Result writes require the current generation, attempt token, and unexpired lease. Heartbeats renew only the active lease using database time. Expired attempts cannot renew or overwrite a newer attempt.

Retries use bounded backoff with jitter and a durable attempt budget, including crash recovery. An expired job is reclaimable without another Kafka event. No database transaction spans a model or tool network call. An external call may repeat after a crash; fencing protects database results, not external execution or billing.

A terminal failure creates a dead-letter outbox record with its durable failed state. Invalid or unsupported event envelopes are quarantined before their offsets are acknowledged; they are not retried as AI jobs. Records with invalid tenant metadata must never be used to grant access.

Authorized replay of a failed ticket atomically increments its generation, returns it to queued, and creates an audit record and a new outbox event. A late event for an older generation cannot schedule work for the current generation. Replay preserves the original ticket and its previous execution records.

## Idempotency contract

Submission keys are scoped by authenticated tenant and operation. A database uniqueness constraint arbitrates concurrent requests. The payload hash is computed from validated canonical input. Identical retries return the same ticket and status URL; different input with the same key returns `409 Conflict`.

For the local demonstration, submission keys remain for the lifetime of the associated ticket; no automatic expiry is planned. A documented database reset removes both. Consumer uniqueness on `(consumer_name, event_id)` suppresses repeated delivery; job uniqueness additionally prevents different event IDs from scheduling the same generation twice.

These guarantees concern committed business effects. They do not imply exactly-once model calls, end-to-end event ordering across topics, or zero duplicate Kafka messages.

## AI and security boundaries

Authentication resolves server-owned tenant membership. Caller-provided tenant IDs never confer access. Ticket reads, replay, retrieval, and tools enforce tenant scope. Cross-tenant resource lookups return a non-disclosing response.

Retrieved documents and model outputs are untrusted. The application owns tool allowlists, argument validation, tenant context, step limits, deadlines, output limits, and per-attempt budgets. Tools are initially read-only; model instructions cannot grant permissions. An answer may abstain when evidence is insufficient.

The deterministic provider tests workflow behavior. Real-provider evaluations separately measure retrieval, citations, abstention, and tool use against a versioned dataset. Neither successful execution nor simulated output proves answer quality.

Demo credentials are fictional and local-only. Fault injection is opt-in and must not expose unrestricted administrative HTTP endpoints. The proposed Redis rate-limit failure policy is to reject affected API operations with `503`, while already scheduled work continues.

Telemetry excludes credentials, document content, prompts, and answers by default. Event metadata carries IDs, schema version, tenant scope, correlation/causation IDs, and trace context. Metrics include outbox lag, queued job age, retry counts, dead letters, execution latency, and dependency failures.

## Acceptance scenarios

The implementation must provide reproducible checks for:

- CLI submission through API, outbox, Kafka, and simulated execution.
- Concurrent identical requests producing one ticket; payload mismatch returning a conflict.
- Duplicate events producing one job per generation.
- Recovery after crashes before publication, after publication, and after job scheduling.
- Lease expiry and stale-attempt result rejection.
- Bounded retries, inspectable failure, authorized replay, and stale-generation rejection.
- Cross-tenant ticket, document, and tool access denial.
- Trace correlation without sensitive payload disclosure.

These are future acceptance criteria, not passing test results.

## Remaining design work

Before application scaffolding, review the HTTP/event contracts, relational constraints and indexes, threat model, and focused ADRs. Resolve database tooling, Kafka client, runtime versions, lease/retry parameters, local authentication, retrieval baseline, evaluation thresholds, telemetry viewer, and resource requirements.

Approving this overview approves the design direction only. Implementation remains gated on the remaining architecture review.
