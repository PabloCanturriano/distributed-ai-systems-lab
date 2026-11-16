# Observability design

Status: planned instrumentation and local inspection; no traces, dashboards, or metric results exist yet.

## Signals and topology

API and worker use OpenTelemetry with an internal Collector. Traces go to Jaeger; metrics are available to Prometheus. Structured application logs go to stdout with safe correlation metadata; no separate log-storage platform is required initially. The [Collector](https://opentelemetry.io/docs/collector/) separates application instrumentation from backend export configuration.

Use service names `lab-api` and `lab-worker`, plus worker role, revision, and provider mode as bounded resource attributes. Instrument HTTP acceptance, submission transaction, outbox publication, consumer admission, job claim, retrieval, model call, tool call, and terminal persistence. Include safe error classification and elapsed time, not payloads.

Propagate bounded validated trace context through Kafka headers. Durable jobs retain origin trace metadata for a linked execution span; retries may create new traces linked to their origin rather than pretending the original HTTP request remained open for minutes. CLI output provides trace IDs or search hints; it must not invent a direct trace URL when a trace was not sampled or persisted.

For the fictional local demo, sample all traces initially to make inspection practical. Bound exporter queues, flush time, and in-memory buffers. Sampling/retention need reconsideration for a hosted system. Telemetry loss is observable but cannot prevent ticket/outbox commits or successful business responses.

## Proposed metric families

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
