# Inspect the phase-2 ticket trace

Status: phase-2 tracing is committed. The phase-3 working tree extends the parent chain and adds opt-in [OTLP inspection](observability.md), subject to exact-patch review. The CLI emits trace hints rather than claiming a persisted viewer URL.

## Follow a local operation

Build/start the complete workflow as described in the [CLI guide](ticket-cli.md), then submit:

```sh
docker compose run --rm -T cli ticket create --message 'A fictional trace inspection ticket' --key trace-review-1 --json
```

The receipt remains the existing three-field HTTP contract. CLI envelope fields add `traceId` for the latest validated HTTP response context and `acceptedTraceId` for the accepted mutation. `demo` keeps the latter while polling. To find the asynchronous stages, replace `TRACE_ID` with the 32-character lowercase hex ID:

```sh
docker compose logs --no-color api relay consumer executor | rg 'TRACE_ID'
```

Look for `event: trace_span` and stages `http.submit`, `outbox.publish`, `consumer.admit` and `execution.run`. The extended chain is HTTP → submission transaction → publication → admission → job claim → execution → result persistence. The outbox stores the transaction origin, the job stores the admission origin, and a successful claim supplies the executor child context after commit. Result persistence ends after the SQL transaction commits. Claim timing includes its transaction; no exporter is awaited while holding a business lock. Request IDs, ticket/event/attempt IDs and generation provide further safe search keys where available. HTTP reads and replay have separate fixed stage names.

A span outcome describes the observed stage, not an independent authority for ticket state. In particular, an interrupted/uncertain completion can have committed. Read the API and retain the idempotency key to resolve an ambiguous write. The broker offset handoff is verified separately; `consumer.admit` describes durable admission even when a later offset acknowledgement fails.

Trace IDs are diagnostic metadata, not authorization or idempotency identity. A retried request can have a different trace from its original durable operation, especially when the original response headers were lost. Use ticket ID and generation to locate that operation rather than assuming a historical receipt carries the original trace ID. Separate CLI invocations do not persist client trace state. An ID in a response does not guarantee the span survived log export/retention.

## Propagation and persistence

The shared `@lab/telemetry` port uses the official OpenTelemetry API/SDK with explicit parent contexts. There is no process-global active span shared between concurrent requests or executor handlers. Supported incoming context is a canonical, nonzero-ID, 55-byte W3C version-00 `traceparent` with flags `00` or `01`. Unsupported/malformed, duplicate/array-valued or oversized context is discarded; business processing continues with a new trace. Baggage and tracestate are not forwarded or recorded. Local manual tracing samples all newly created spans, including when an accepted parent has an unsampled flag.

The scheduling transaction span context is stored in the optional outbox origin column, outside the immutable business payload/digest. Relay creates a child and publishes its context as a real Kafka header. The consumer creates another child and stores it with the admitted job. A later executor process starts from that stored origin. Old rows remain valid with null origins. Duplicate event delivery does not replace a job's original context; same-key submissions do not change the event's first origin or request hash. Failure notifications inherit the job origin.

The tenth migration adds nullable, constrained context columns and insert-only metadata grants. Runtime roles cannot rewrite those origins. No credential, tenant scope, generation guard or ownership predicate is derived from trace metadata. Internal roles and the local host remain trusted; this does not add tenant RLS.

## Disclosure and bounds

Instrumentation is manual. It records fixed service/role/stage/outcome values, valid IDs, generation and elapsed time. It does not automatically capture HTTP headers/URLs, SQL, exceptions, authorization, messages, answers, provider details or document/tool contents. Metadata is allowlisted at the shared port and again in the span projection. Spans have six bounded attributes and no SDK events/links.

The local sink has no exporter queue, network call or export timer. It drops a record above 2 KiB or when stdout is destroyed or already has more than 32 KiB buffered; one accepted record can add at most 2 KiB before the next check. This bounds telemetry's added stream buffering, not other application logs or Docker disk retention. Sink errors are contained and cannot change a committed result or a successful HTTP response. Dropped spans reduce diagnostic visibility. The phase-3 OTLP mode adds loss counters, remaining workflow spans and [bounded Collector export](observability.md); the local-only sink itself remains free of network I/O.

The [complete phase-2 gate](../quality/phase2.md) verifies the real parent chain across relay/consumer/executor restarts, tolerates invalid context, checks secrets/excerpts are absent and preserves normal idempotency/tenant behavior. It also retains real PostgreSQL, offset/crash and CLI acceptance gates. Trace log correlation alone is not proof of those transactional guarantees.
