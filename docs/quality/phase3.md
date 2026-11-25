# Phase 3: failures, recovery and inspection

Status: locally complete. All 14 mandatory gates and all 42 criteria passed on 2026-11-24, with unchanged implementation sources. The owner approved the exact five-patch manifest and the batch was committed/pushed through `7651620`; [x64/ARM64 CI passed](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45525531992). Architecture for the separate repair boundary was explicitly approved in ADR-0008. No unseen code commit is authorized. The committed phase-2 base is `522d404`, with successful x64/ARM64 CI; hosted CI for this phase requires the subsequently approved commits to be published.

## Scope

The batch adds an isolated operational login/image, safe quarantine inspection and read-only plans, project/environment/hash confirmation, canonical same-generation repair and immutable audit/receipt persistence. It adds bounded HTTP OTLP export, actual transient Jaeger/Prometheus inspection, safe durable operational aggregates, exporter/drop instrumentation and the missing transaction/claim/result spans. CLI scenarios distinguish API assertions from host authority; fixed host harnesses require observed crash checkpoints before success.

Classified retries, three-attempt exhaustion, failure notifications, expected-generation replay, stale-generation/attempt fencing and SQL/offset handoff already existed. They remain mandatory regression evidence rather than being described as newly implemented.

The new response-before-persistence scenario observes two simulated provider responses and one persisted result after a real lease expiry. This demonstrates possible repeated external calls; it does not establish exactly-once third-party effects. No retrieval, tools, real model, citation quality or production release is implemented in this phase.

## Complete gate

Run `npm run test:phase3` on Node 24.22.3 with Docker/Compose. It requires all 14 commands, all 42 unique criteria, valid references to unfocused/unskipped test evidence and an unchanged implementation source digest. It fails on a missing/failed gate or changed source. `artifacts/phase3-report.json` records base revision, dirty status, Node/platform/architecture, gate durations, criterion status and source digest; generated evidence is ignored by Git and contains no raw logs.

Commands: `check`, `test:database`, `test:tracing`, `test:containers`, `test:compose`, `test:kafka`, `test:relay`, `test:consumer`, `test:executor`, `test:cli`, `test:replay`, `test:operations`, `test:response-crash`, `test:observability`.

The complete gate includes historical phase-2 acceptance, new phase-3 criteria and the initial SEC-01..03 subset. DATA-08 requires future document-version/citation work. Broader security, performance, release and live-provider evaluations remain separate.

## Evidence map

See the [machine-readable manifest](phase3-acceptance.json) for exact executable references. An evidence reference alone is not a passing run; every linked gate must finish successfully against the recorded digest.

| Criteria            | Required observations                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP-01..08         | Atomic acceptance, concurrent/canonical idempotency, lost replies, role-gated concurrent replay and stable historical receipt                                           |
| EVENT-01..06        | Real Kafka, durable inbox/job before offsets, safe quarantine, no offset skips and stale-generation rejection                                                           |
| DATA-01..07, 09..10 | Relational/tenant identity, stored attempt budgets, lease fencing, atomic result/failure/replay/repair and ambiguous commit recovery                                    |
| CLI-01..06          | Docker-only HTTP client, stable retry keys, JSON/exit/deadline semantics, authorization and refusal to certify host crashes from API-only requests                      |
| REC-01..06          | Broker recovery, observed executor loss/real lease expiry, authorized replay, audited idempotent repair, both late-event orders, project/environment/stale-state guards |
| OBS-01..04          | Actual seven-stage Jaeger trace and parent references, bounded export under outage, Prometheus backlog/attempt metrics, secret/private-fixture exclusion                |
| SEC-01..03          | Credential/tenant isolation and reader/requester/operator behavior retained from phase 2                                                                                |

## Operational boundaries

[Repair guide](../operations/delivery-repair.md), [observability guide](../operations/observability.md), [recovery runbook](../operations/recovery.md) and [scenario interface](../architecture/cli.md) explain execution and limitations. Normal repair never deletes volumes, rewinds offsets, changes generations/budgets or completes a job. Harness cleanup deletes only generated disposable projects.

SQL grants constrain columns and roles; trusted application modules enforce tenant/expected-state/idempotency rules. The operations actor is a database session identity, not a human identity system. Inspection services and signal counters are transient. No exactly-once telemetry or hosted monitoring availability is claimed.

## Recorded local verification

`npm run test:phase3` completed with `status: passed`: 292 fast tests in 20 suites, 189 PostgreSQL tests in five suites, all 14 mandatory gates, all 42 criteria and actual trace correlation. Compared with the phase-2 record, this adds 17 fast tests and 21 PostgreSQL cases; host acceptance assertions are additional to those Jest totals.

Source digest: `37b11e91944eadf9603a7d1adf7cebb394e79652c9883223ce682c29201e93ed`. Base revision: `522d404d8604a300f885e4ebb7268616f3665553`. The report records Node 24.22.3, darwin/arm64, `workingTreeDirty: true` and 762360ms of gate execution. This describes the prepared working tree, not committed or hosted phase-3 CI. The report is generated at `artifacts/phase3-report.json`; a fresh clone must run the gate to produce its own evidence.

Real acceptance includes canonical same-generation repair through Kafka, project/environment/hash guards, additive credential preservation, missing credential rejection, observed publication/admission crashes, two simulated provider responses after real lease expiry with one persisted result, seven actual Jaeger stages/parent references, Prometheus aggregates, business completion with Collector stopped and private-fixture/credential exclusion.
