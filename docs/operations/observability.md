# Observability design

Status: the phase-2 base is committed. The phase-3 OTLP topology, bounded exporters and operational metrics are implemented in the working tree and passed the complete local [acceptance gate](../quality/phase3.md); exact-patch review remains pending. This is local lab instrumentation, not a hosted monitoring service.

## Signals and topology

The opt-in phase-3 topology connects API/worker OpenTelemetry over internal HTTP OTLP to a Collector, exports traces to transient Jaeger storage and exposes metrics to Prometheus. The current phase-2 implementation projects manual SDK spans into bounded local logs. Structured application logs go to stdout with safe correlation metadata; no separate log-storage platform is required initially. The [Collector](https://opentelemetry.io/docs/collector/) separates application instrumentation from backend export configuration.

Use service names `lab-api` and `lab-worker`, plus worker role, revision, and provider mode as bounded resource attributes. Instrument HTTP acceptance, submission transaction, outbox publication, consumer admission, job claim, retrieval, model call, tool call, and terminal persistence. Include safe error classification and elapsed time, not payloads.

Propagate bounded validated trace context through Kafka headers. Durable jobs retain origin trace metadata for a linked execution span; retries may create new traces linked to their origin rather than pretending the original HTTP request remained open for minutes. CLI output provides trace IDs or search hints; it must not invent a direct trace URL when a trace was not sampled or persisted.

For the fictional local demo, sample all traces initially to make inspection practical. Bound exporter queues, flush time, and in-memory buffers. Sampling/retention need reconsideration for a hosted system. Telemetry loss is observable but cannot prevent ticket/outbox commits or successful business responses.

## Metric families

| Family | Interpretation | Safe dimensions |
| --- | --- | --- |
| HTTP requests/duration | Traffic, rejection, dependency responses | Route template, method, status class |
| Outbox pending count/oldest age | Publication backlog and blocked work | Event type, worker role |
| Jobs by state/oldest eligible age | Scheduling backlog and recovery pressure | State, role |
| Attempts and retries | Failure classification and budget use | Outcome, safe reason, provider mode |
| Lease loss/rejected stale result | Ownership races and recovery | Operation, role |
| Quarantined events | Producer/schema problems | Allowlisted reason, topic |
| Model/tool calls and duration | Latency, failure, budget boundaries | Configured provider alias, tool name, outcome |
| Dependency/export failures | Infrastructure degradation | Configured dependency name, safe class |

Do not label metrics by ticket ID, principal, tenant, document, raw URL, prompt, or exception text. IDs can appear in restricted structured logs/traces where required, but are not high-cardinality metric dimensions. Histograms and units must be explicit and tested once instruments are implemented.

## Diagnosis examples

A queued ticket with rising outbox age suggests publication problems; a published event with no durable job suggests admission/consumer problems; an eligible job with no claim suggests executor problems. A lease-loss spike points to slow heartbeats, database delay, or worker pauses rather than automatically proving broker failure.

Use queue age and state alongside process health. A healthy HTTP server can accept tickets while Kafka is unavailable; the outbox backlog makes that degradation visible. No alert threshold is called an SLO until measured expectations exist.

## Disclosure policy

Use allowlisted structured fields. Suppress authorization/cookies, secret file contents, connection strings, SQL parameter values, message bodies, retrieved documents, model prompts/answers, raw tool output, and provider error payloads. Scrubbing is a defense, not permission to capture all data first. Test fake sentinel secrets through automatic and manual instrumentation paths.

## Acceptance additions

- OBS-01: a simulated ticket can be followed from HTTP to publication, admission, execution, and result with valid propagation/links.
- OBS-02: a Collector outage preserves business results and exporter memory/time bounds.
- OBS-03: metric families expose backlog/retries without ticket or tenant label cardinality.
- OBS-04: sentinel secrets and fictional private excerpts are absent from default logs and exported spans.

Inspect one complete trace and representative metric output before marking these controls implemented. Do not replace evidence with a screenshot of an empty viewer.


## Run and inspect locally

```sh
LAB_TELEMETRY_MODE=otlp docker compose --profile messaging --profile execution --profile observability up --build --detach --wait --wait-timeout 180
docker compose run --rm --no-deps -T cli demo --json
```

Jaeger is bound to `http://127.0.0.1:16686`; search `lab-api` or `lab-worker` by the CLI's accepted trace ID. Prometheus is bound to `http://127.0.0.1:9090`; query `lab_stage_completions_total`, `lab_stage_duration_seconds_bucket`, `lab_outbox_pending`, `lab_outbox_oldest_seconds`, `lab_jobs`, `lab_attempts`, `lab_quarantine`, `lab_expired_leases`, `lab_queue_oldest_seconds`, `lab_snapshot_age_seconds`, `lab_operational_failures_total`, `lab_telemetry_dropped_total` and `lab_telemetry_export_failures_total`. `LAB_JAEGER_PORT` and `LAB_PROMETHEUS_PORT` override loopback ports. Collector OTLP/Prometheus-exporter ports remain internal. No business readiness check depends on these services.

The profile starts inspection services; `LAB_TELEMETRY_MODE=otlp` separately enables export. Default `local` mode keeps the safe stdout projection and performs no operational aggregate polling. Recreate application containers when changing the mode. Export endpoints are fixed internal aliases, with no credential or arbitrary remote endpoint option.

HTTP traffic uses fixed `http.submit/replay/read` stage/outcome series and a seconds histogram with boundaries 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 15 and 60. It does not instrument health probes or arbitrary routes. Other fixed stages cover transaction, publication, admission, claim, execution and result persistence. Model/tool/retrieval instruments await their corresponding implementations; no calls to those systems are fabricated.

A relay-owned read-only transaction refreshes the aggregate cache at most once per five seconds with a 500ms SQL statement limit. `lab.operational_metrics` exposes only metric/dimension/value, without extending relay access to base jobs or quarantine. Failed refreshes retain the previous sample; use snapshot age (`-1` means never observed) alongside backlog values. Attempts/quarantine/state metrics are gauges derived from durable rows; stage and error counters are best effort per-process observations. There are no tenant/ticket IDs in metric labels.

Each process retains at most 128 queued spans plus one batch of at most 32 in flight. The HTTP exporter has one request in flight and a 750ms timeout; a stalled callback never enables another concurrent request. The queue drops excess spans, the deadline is counted, and shutdown discards queued work within a bounded exporter wait. Metrics export every two seconds with a one-second reader deadline, the same 750ms request limit and a 256-series per-instrument SDK limit. Trace and metric export failures, stdout/queue drops and queue occupancy are observable after restoration. A process killed during an outage can lose both signals and its in-memory loss counters; no durable telemetry delivery is promised.

Collector memory limiting precedes finite batching; the Jaeger exporter has a finite 16-batch queue and five-second retry budget. Jaeger retains at most 5,000 traces in memory; Prometheus has transient storage with a two-hour/64MB retention setting and a 100MB filesystem bound. Container memory caps are 192MB for Collector and 256MB each for Jaeger/Prometheus. Inspection data may be evicted or lost on restart, resource exhaustion or outage. None of these limits establish a performance SLO or a production deployment.

`npm run test:observability` queries actual Jaeger spans/parent references and Prometheus series, checks fixture/credential disclosure, stops Collector, observes ordinary ticket completion, restores export and verifies failure counters. It uses empty volumes and cleans only its generated project. `npm run test:response-crash` separately proves possible repeated provider responses before one durable result.
