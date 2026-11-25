# Recovery runbooks

Status: the initial worker/relay recovery behavior is committed. Operator replay over API/CLI is committed and verified below. The phase-3 working tree adds [local delivery repair](delivery-repair.md), fixed [host scenarios](../architecture/cli.md) and [OTLP observability](observability.md); final gate evidence and exact-patch review are recorded separately.

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

The approved dedicated operator repair operation for a valid current queued execution with no job: it requires explicit tenant/ticket/generation, expected current scheduling event ID, reason, and a stable repair idempotency key. Lock the ticket and verify all expectations. Reject if work is already scheduled, the generation changed, or the execution is not queued.

Build a fresh canonical scheduling event from authoritative execution records, not quarantined bytes. Atomically write a new immutable outbox event, advance the execution's active scheduling-event reference, persist the repair receipt, and audit old/new IDs. Preserve all old outbox and quarantine records. A repeated repair key returns its original receipt without another event. Existing old events may still arrive; inbox/job uniqueness prevents duplicate work. The failure notification causation uses the event that actually scheduled the job, recorded at admission.

This is delivery repair within the same generation, distinct from replay of a failed execution. It does not reset an attempt budget, bypass Kafka, change documents, or mark work completed. Non-current/unknown executions are inspected and left quarantined; do not create tickets from them.

The operator interface, grants, session actor and receipt persistence were explicitly approved for implementation in [ADR-0008](../adr/0008-local-delivery-repair.md); the exact patch still requires review. Store repair receipts in the scoped idempotency mechanism using a distinct operation version; do not reuse submission/replay scope. No hidden automatic repair runs at startup.

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


## Replay of a failed ticket

After reviewing the failure and correcting its cause, read the current ticket and explicitly replay that failed generation with an operator identity:

```sh
docker compose run --rm --no-deps -T cli ticket get <ticket-id> --identity harbor.operator --json
docker compose run --rm --no-deps -T cli ticket replay <ticket-id> --generation 1 --key recovery-ticket-1 --identity harbor.operator --json
docker compose run --rm --no-deps -T cli ticket wait <ticket-id> --identity harbor.operator --deadline 60 --json
```

Replace the ID and generation with the inspected values; the example's generation 1 is not an automatic discovery instruction. The CLI image must already be built and the stack started with both messaging/execution profiles as described in the [CLI guide](ticket-cli.md). The CLI is an on-demand image, not a continuously running service.

Only an operator may replay. A new key requires the ticket to be failed at exactly the supplied generation; queued, processing, completed or changed-generation tickets return 409 `REPLAY_CONFLICT`. A reader/requester receives 403, and foreign/missing tickets return the same 404. The ordinary local provider completes with a simulated abstention, which is ineligible for replay; no runtime fault switch is introduced to force a demo failure.

Replay returns a new queued generation. The prior execution, failure/job/attempt history and notification remain durable. The new scheduling event must traverse relay and Kafka/consumer admission before the executor can run it. There is no failed-topic consumer that automatically replays work. A new generation gets its own attempt budget; a duplicate replay request does not reset that budget.

Use a stable key and the same expected generation when retrying a lost response. The original receipt is returned even after the new generation progresses; its generation may therefore differ from a later current ticket read. Reusing that key with another generation returns 409 `IDEMPOTENCY_CONFLICT`. Different concurrent keys for the same expected generation produce one replay and one conflict. Replay and initial submission use distinct operation scopes, and replay keys are also scoped by ticket.

`POST /v1/tickets/{ticketId}/replays` accepts only `{ "expectedGeneration": 1 }` plus `Idempotency-Key`; the server owns tenant/principal/request identity. Replay shares submission's mutation/principal rate budgets. Expected generation must be an integer from 1 through 2147483646 so incrementing cannot overflow the PostgreSQL integer. CLI replay requires both `--generation` and `--key`, performs no implicit replay and does not automatically retry conflicts. It reports acceptance; use `ticket wait` to observe completion.

The audit record, receipt, new execution, pointer change and outbox commit together. Internal audit records store actor, old/new generation and originating request ID, with no credential, question or answer payload. This batch adds no public history/audit or quarantine-repair endpoint. Client timeout does not establish that a replay failed to commit; keep the same key to resolve an uncertain outcome.

`npm run test:replay` creates a real failed first generation via a trusted test-only worker actor after Kafka admission, then exercises the public operator replay/CLI. It proves the second generation stays queued with the consumer stopped and finishes through Kafka after restart, with history preserved. The actor is not copied into application images or exposed through the API. See [batch evidence and proposed commits](../quality/reviews/0022-ticket-replay-batch.md).


## Observed response-before-persistence crash

`node scripts/scenarios.mjs run crash-after-response` uses a trusted test-only executor actor in a generated project. The actor prints a checkpoint only after the provider returned and immediately before calling durable completion. The host observes that checkpoint, verifies zero results, kills that actor, observes the real 30-second database lease expire and starts a replacement actor through `JobExecutor`. Its second provider response is observed; the attempt history is expired/succeeded and exactly one result exists. A completion with the old token returns false.

The test provider is simulated. Two observed responses demonstrate possible repeated external calls, not a real third-party side effect. A transaction cannot make a nontransactional external response exactly once. Future side-effecting adapters require their own idempotency protocol; this phase makes no such guarantee. Actor code is injected only by the trusted harness and is absent from application image inputs.
