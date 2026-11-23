# Ticket HTTP and event contracts

Status: authenticated submission, queued/processing reads, SQL admission and native consumption are committed. [Fenced simulated completion and terminal reads](../quality/reviews/0019-simulated-completions.md) are prepared for review: only simulated insufficient-evidence results and allowlisted failures are implemented. Answered/cited results, automatic execution and replay remain planned. Read with the [architecture overview](overview.md) and [ADR-0001](../adr/0001-durable-ai-execution.md).

## Common HTTP rules

Business routes use `/v1`, JSON, and bearer authentication. Credentials resolve to server-owned tenant membership and permissions. The client cannot select a tenant through a header or body field. Local credential provisioning is defined in the [security proposal](security.md).

IDs are UUID strings. Timestamps use UTC ISO 8601 strings. Generations are positive integers starting at 1. Request objects reject unknown properties. JSON mutation bodies are limited to 16 KiB; unsupported content types return `415`, oversized bodies `413`, and malformed or invalid input `400`.

Business responses include a server-generated `X-Request-Id` and `Cache-Control: no-store`. Requests and responses must not echo bearer tokens. Authenticated mutation and read endpoints are subject to rate limits: `429` when exceeded, or `503` if the required limiter is unavailable. Retriable HTTP responses may include `Retry-After` in integer seconds.

## Routes

| Method and route | Permission | Success |
| --- | --- | --- |
| `POST /v1/tickets` | `tickets:create` | `202` with a stable acceptance receipt |
| `GET /v1/tickets/{ticketId}` | `tickets:read` | `200` with the current generation's state and result |
| `POST /v1/tickets/{ticketId}/replays` | `tickets:replay` | `202` with a stable receipt for the new generation |

Missing or invalid credentials return `401`; a valid identity without the route permission receives `403`. For a permitted operation, a missing ticket or a ticket outside the caller's tenant returns the same `404` representation. Read, replay, and idempotency lookups are always tenant-scoped.

## Submission

`POST /v1/tickets` requires `Idempotency-Key`, an opaque case-sensitive string of 1-128 ASCII letters, digits, periods, underscores, or hyphens. Clients should generate a fresh random key for each intended operation and reuse it for retries.

Body:

```json
{
  "message": "How do I rotate an API key?"
}
```

`message` must be a nonempty string after trimming leading and trailing whitespace, with at most 4,000 Unicode code points after trimming. Interior whitespace and case are preserved. The persisted message and hash input use this validated value. Unicode normalization is not performed. NUL and unpaired Unicode surrogates are rejected because they cannot round-trip as PostgreSQL UTF-8 text.

The canonical hash input is UTF-8 JSON with exactly one field, `message`, serialized without optional whitespace. Include operation version in the hash scope so future contract changes cannot silently reinterpret stored keys. HTTP authentication, trace IDs, and request IDs are not payload fields.

The transaction persists the ticket, idempotency receipt, and scheduling outbox event together. Success returns a `Location` header equal to `statusUrl`:

```json
{
  "ticketId": "11111111-1111-4111-8111-111111111111",
  "generation": 1,
  "statusUrl": "/v1/tickets/11111111-1111-4111-8111-111111111111"
}
```

The key scope is `(tenantId, operation, resourceScope, key)`: operation is `tickets:create:v1` and resource scope is a fixed collection marker for submission. An identical retry returns `202` and the original receipt, even if processing has completed. Fetch current state through `statusUrl`. Different validated input with the same scoped key returns `409` with code `IDEMPOTENCY_CONFLICT`.

Keys and receipts remain for the ticket lifetime in the local demo. Validation, authorization, or rolled-back persistence failures do not reserve a key. Database uniqueness resolves races; a temporary inability to obtain the winning receipt returns a retryable `503`, never a second ticket. Authorization is checked on every request, including retries.

## Reading a ticket

`GET /v1/tickets/{ticketId}` returns:

```json
{
  "ticketId": "11111111-1111-4111-8111-111111111111",
  "generation": 1,
  "status": "queued",
  "createdAt": "2026-11-15T12:00:00.000Z",
  "updatedAt": "2026-11-15T12:00:00.000Z",
  "result": null,
  "failure": null
}
```

State-dependent fields:

| State | `result` | `failure` |
| --- | --- | --- |
| `queued` or `processing` | `null` | `null` |
| `completed` | Result object | `null` |
| `failed` | `null` | Sanitized failure object |

A result has `outcome` (`answered` or `insufficient_evidence`), `answer` (string), `citations` (array), and `execution` (summary). Each citation has `documentId`, `documentVersion`, and `chunkId`; references must resolve to the ticket tenant's stored corpus version. An `answered` result requires at least one valid citation. Abstention uses `insufficient_evidence`, an explanatory answer, and an empty citation array; it is a successful completion, not an infrastructure failure.

The execution summary contains `providerMode` (`simulated` or `real`), `attemptCount`, and `toolCalls` with only tool name and outcome (`succeeded` or `failed`). It excludes arguments, raw outputs, prompts, and internal exceptions. Summary sizes follow the proposed [runtime budgets](runtime-limits.md).

A failure has an allowlisted `code` and safe `message`. Initial codes are `EXECUTION_FAILED` and `ATTEMPTS_EXHAUSTED`. Provider errors, credentials, SQL, stack traces, and document excerpts are never copied into it. Generation history, ticket lists, streaming, and cancellation endpoints are outside this first contract.

## Replay

`POST /v1/tickets/{ticketId}/replays` requires `Idempotency-Key` and:

```json
{
  "expectedGeneration": 1
}
```

The operation scope is `tickets:replay:v1` and the resource scope is the ticket ID. Hash the validated body with its single field in the same deterministic manner as submission. Identical scoped-key retries return the original `202` receipt, checked before evaluating the current lifecycle state. Changed input returns `IDEMPOTENCY_CONFLICT`.

For a new key, only a failed ticket at `expectedGeneration` is eligible. Otherwise return `409` with `REPLAY_CONFLICT`. One transaction locks or conditionally updates the ticket, increments generation, clears the current result/failure, and stores the receipt, audit record, and new scheduling outbox event. Concurrent different-key replay requests for the same expected generation yield one success and one conflict.

The receipt has the submission receipt's shape with the new generation. Previous execution records remain durable. Reads show the current generation; an old receipt does not imply that generation remains current. Replay retries are safe after a lost response and cannot create another generation with the same key.

## HTTP errors

Application-generated errors have this shape:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "This key was already used with different input.",
    "requestId": "22222222-2222-4222-8222-222222222222"
  }
}
```

Other initial codes: `INVALID_REQUEST`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `DEPENDENCY_UNAVAILABLE`, and `INTERNAL_ERROR`. They map to `400`, `413`, `415`, `401`, `403`, `404`, `429`, `503`, and `500` respectively. Unknown errors use a generic message. HTTP success receipts remain stable; response request IDs are new for each HTTP attempt.

## Scheduling event

Topic: `tickets.execution-requested.v1`. Partition key: ticket ID. Both initial submission and replay publish `ticket.execution.requested`, version `1`. Retry execution does not publish another scheduling event.

```json
{
  "eventId": "33333333-3333-4333-8333-333333333333",
  "type": "ticket.execution.requested",
  "version": 1,
  "occurredAt": "2026-11-15T12:00:00.000Z",
  "tenantId": "44444444-4444-4444-8444-444444444444",
  "ticketId": "11111111-1111-4111-8111-111111111111",
  "generation": 1,
  "correlationId": "22222222-2222-4222-8222-222222222222",
  "causationId": "22222222-2222-4222-8222-222222222222",
  "data": {
    "reason": "submitted"
  }
}
```

`reason` is `submitted` or `replayed`. Correlation identifies the originating operation; causation identifies its immediate command request or parent event. A replay starts a new operation correlation ID and is linked to the same ticket in audit records. Relay retries preserve event ID and payload.

Trace context is optional Kafka header metadata, propagated with bounded length and validation; it is not an authorization credential. A missing or invalid trace context never prevents otherwise valid business processing. Topic name and payload version must agree.

The consumer validates size (at most 16 KiB UTF-8), required fields, UUIDs, timestamps, supported type/version, generation, reason, and partition-key agreement. Additive unknown envelope/data fields may be ignored within the size limit; they never affect permissions or scheduling. Optional additive fields may evolve within v1; changed field meanings, required additions, and incompatible types require a new version and rollout decision.

Before scheduling, the consumer loads authoritative ticket state and checks tenant, generation, and expected submission/replay reason. Older valid generations are recorded as ignored without new work. Unknown tickets, tenant mismatches, and impossible future generations are quarantined with sanitized reason codes; they never create tickets. Existing jobs suppress scheduling even if another event ID is delivered for that generation. Event ID reuse with a different payload is a producer contract violation and must be quarantined rather than treated as a normal retry.

## Quarantine and terminal failures

Invalid events are durably quarantined using topic, partition, and offset as the source identity, plus a payload digest and safe reason. Raw content is not exposed through business APIs or default logs. A consumer commits only contiguous offsets whose handling is durable; inability to persist quarantine blocks acknowledgement and raises operational telemetry.

Execution failure emits a separate outbox notification to `tickets.execution-failed.v1`, type `ticket.execution.failed`, version `1`. It uses the same identity envelope, ticket generation, and ticket partition key, with `data` containing only `failureCode` and `attemptCount`. Its correlation comes from the scheduling operation and its causation is the event ID recorded by the job at admission, including an explicitly repaired delivery. It is not consumed as a scheduling command; there is no automatic failure-topic-to-replay loop.

Kafka publication failure cannot erase the failed ticket: its state and pending failure notification are committed together. Quarantine retention follows the [data model](data-model.md); authorized inspection and same-generation delivery repair follow the [recovery proposal](../operations/recovery.md).

## Acceptance specifications for TDD

These scenarios guide executable tests; current passing submission subsets and limits are recorded in the linked HTTP review. Each new behavior must first fail for missing behavior, then pass through the smallest implementation change.

| ID | Given / when | Expected outcome |
| --- | --- | --- |
| HTTP-01 | Valid submission | `202`; one ticket, key receipt, and outbox record commit together |
| HTTP-02 | Concurrent same-key, same-input submissions | Same ticket and receipt; no duplicate outbox effect |
| HTTP-03 | Same scoped key with different validated input | `409 IDEMPOTENCY_CONFLICT`; no new ticket |
| HTTP-04 | Retry after lost response and later completion | Original `202` receipt; GET returns current completed state |
| HTTP-05 | Another tenant requests a ticket or replay | Same `404` as a missing resource; no mutation |
| HTTP-06 | Concurrent replay keys with the same expected generation | One generation increment; one success and one conflict |
| HTTP-07 | Same-key replay retry after processing advances | Original receipt; no additional generation or event |
| HTTP-08 | Validated-equivalent whitespace or JSON formatting | Same hash; case or interior-whitespace changes conflict |
| EVENT-01 | Same scheduling event delivered repeatedly | One inbox effect and one job for that generation |
| EVENT-02 | Different event IDs for the same valid generation | Multiple inbox identities, at most one job |
| EVENT-03 | Crash after job commit but before offset commit | Redelivery finds durable work without duplicating it |
| EVENT-04 | Invalid envelope, tenant mismatch, or event ID collision | Durable quarantine; no executable job from invalid input |
| EVENT-05 | Earlier offset unpersisted, later record handled | Commit does not skip the earlier record |
| EVENT-06 | Old generation delivered after replay | Ignored; no job for the current generation |
| RESULT-01 | Insufficient evidence | Completed abstention with empty citations |
| RESULT-02 | Provider exception includes a fake secret | Safe API failure and telemetry; no secret disclosure |

HTTP and event contracts will become machine-readable schemas during implementation. The [CLI](cli.md), [AI/tool design](ai-system.md), and [recovery procedures](../operations/recovery.md) specify their separate boundaries. This proposal does not remove the architecture implementation gate.
