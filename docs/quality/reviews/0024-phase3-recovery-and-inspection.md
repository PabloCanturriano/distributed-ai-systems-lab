# Phase 3: recovery and operational inspection

Status: implementation and tests are prepared in the working tree against committed/pushed base `522d404`. The owner explicitly approved ADR-0008 for implementation/testing. The complete local phase-3 gate passed; final counts/digest are recorded in [phase-3 acceptance](../phase3.md). Exact code patches require approval before any code commit. Existing push authorization applies after that approval.

## Proposed logical commits

1. **`feat: add audited delivery repair with isolated operator authority`**
   - On-demand `@lab/operations` image/workspace and fixed host inspect/plan/repair entry point; no public endpoint, business credential, Docker socket or job-execution authority.
   - Separate role/login and additive private credential provisioning, immutable environment identity, safe quarantine/current-state inspection, scoped idempotency and append-only repair ledger. Canonical outbox/pointer/receipt/audit writes commit together under ticket-first locking.
   - Real PostgreSQL tests for safe projections, same/different-key races, admission race, both late-event orders/actual failure causation, stale/foreign expectations, rollback/lost acknowledgement, historical receipt and privilege denials. Schema cleanup/upgrade fixtures include new dependent tables; legacy five-login credentials are not silently expanded or rotated.
   - Workspace registration, scoped Docker build inputs, manifest/lock additions and operational Compose profile belong to this patch. Migration 11 is additive and has no destructive rollback.
2. **`feat: export bounded workflow traces and operational metrics`**
   - Official OpenTelemetry HTTP OTLP trace/metric exporters 0.301.2 and metrics SDK 3.1.1, retaining the existing API/trace SDK 3.1.1 family. Serializer dependencies include logs SDK types but install no automatic log capture.
   - Fixed internal endpoints, bounded span queue/batch/concurrency/deadlines, finite metric cardinality, observable drop/export/lease/dependency failures, safe stage counters and seconds histograms. Default local mode retains stdout without aggregate polling.
   - Migration 12 exposes only aggregate metric/dimension/value to the relay. Background read-only refresh has a 500ms SQL limit; failures retain the previous sample with observable age. Base job/quarantine privileges remain denied.
   - Manual transaction/claim/result spans complete the explicit detached parent chain. Optional telemetry defaults preserve protocol tests and durable receipt/payload/ownership behavior. No exporter is awaited while a business transaction holds locks.
   - Opt-in pinned Collector 0.165.0, Jaeger 2.23.0 and Prometheus 3.16.0 profiles/configuration with internal ingest, loopback viewers, memory/queue/retention limits and no business readiness dependency. Package pins, aggregate tests, exporter-bound tests and updated local tracing evidence belong to this patch.
3. **`feat: add checkpointed recovery scenarios and CLI commands`**
   - Business `scenario list` distinguishes API/host authority; `duplicate-submission` verifies two equal receipts. Host entries fail with `HOST_REQUIRED` without authentication/network activity rather than claiming recovery.
   - Fixed host catalog invokes only reviewed repository harnesses, forwards diagnostics to stderr and requires both the observed checkpoint marker and successful complete harness before a passed JSON result.
   - Real Kafka repair, plan/project/environment/hash guards, additive credential preservation and missing-file fail-closed behavior; real Jaeger parent references/Prometheus series, Collector outage completion and disclosure checks.
   - Test-only response checkpoint actor observes a provider return, blocks before completion, is killed by the host and recovers after the real database lease. A second observed provider response yields one immutable result; the old attempt cannot persist. It is not shipped in application images.
   - Existing relay/consumer harnesses continue exercising actual publication-before-ack and SQL-before-offset failure windows. Root commands now require their observed host checkpoints; existing assertions are retained.
4. **`test: enforce the complete phase three acceptance gate`**
   - Fourteen mandatory gates, 42 unique criteria and explicit trace evidence. Invalid/missing/focused/skipped references, nonzero child results or implementation digest drift fail acceptance.
   - The ignored report records exact source identity/environment/durations/results without raw logs. x64 and ARM64 CI both gain operations, response-crash and actual OTLP/backend acceptance. Existing gates remain mandatory.
5. **`docs: record phase three recovery evidence and operational limits`**
   - Updated roadmap/status and operational guides distinguish the published green phase-2 base, locally tested phase-3 patches and unrun new hosted CI. Concrete operator commands, transient monitoring limits, trusted SQL-module boundary and repeated external-call risk are explicit.
   - Retrieval, tools, real-model evaluations, production controls and release remain future phases. Runtime-limit documentation reconciles the implemented shared 10/minute mutation budget and 60-second CLI default rather than claiming the earlier proposals exist.

Shared package/Compose/foundation-test edits are divided by purpose in the review patch series; apply in order. Every new file is included. Review packets contain complete diffs and SHA256 identifiers. Preparing those patches does not alter the owner's Git index or create code commits.

## Validation and limitations

The first three logical patches were also applied in order to isolated copies without changing the owner's index. Patch 1 passed `npm run check` (276 tests, 18 suites) and PostgreSQL integration with only its schema (187 tests, five suites). Patch 2 passed its separate check (281 tests, 19 suites). Patch 3, including the corrected catalog guard, passed its separate check (292 tests, 20 suites). Patch application and byte-for-byte final reconstruction are verified independently of those test results. Final packet hashes are recorded in the external review manifest.

The initial repair test failed because the implementation module did not exist, then passed after implementation. Additional tests cover concrete SQL guarantees, bounded exporter failure and observed host checkpoints. A new completion tracing wrapper initially converted synchronous invalid-input rejection to a rejected promise; the existing regression test caught this and the public boundary's synchronous validation was restored. Docker caught an invalid Prometheus tmpfs list during the first topology run; the quoted mount was corrected. The full gate also detected the foundation test's obsolete six-mount/all-read-only bootstrap expectation. It now verifies seven mounts with only operations writable, and preserves/inspects all seven credential hashes. The expanded disclosure check also exposed a rejected Jaeger search query. It now reads all three known persisted trace IDs through the verified trace endpoint and reports success only after disclosure assertions pass. Three new catalog-boundary tests initially failed on inherited object names; an own-entry check now rejects them before spawning any harness. These failures are not reported as passing acceptance.

Focused evidence before the full gate: 289 fast tests in 19 suites; 189 PostgreSQL tests in five suites; actual Jaeger seven-stage trace/Prometheus metrics and Collector-outage business completion; real Kafka single-job repair, additive credential preservation and missing-file rejection; response-before-persistence crash with two observed provider responses, one result and stale-token rejection. Final combined-gate evidence takes precedence over these earlier runs.

The approved phase-2 head `522d404d8604a300f885e4ebb7268616f3665553` has [successful hosted CI](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45514368977), including x64 and native ARM64. No new hosted phase-3 run or release is claimed before publication.

All local integration mutations target generated disposable projects/databases. Normal operations do not delete volumes, rewind offsets or bypass consumer/executor ownership. SQL grants limit columns/roles, while trusted adapters enforce tenant/expected-state/operation scope. The audit actor is the credential's real database session, not a human identity. Best-effort transient telemetry may be lost. A simulated provider response repeated by a crash is not evidence of exactly-once third-party side effects.

## Final combined verification

The final frozen-source run passed all 14 gates, all 42 criteria and trace correlation. It includes 292 fast tests (20 suites), 189 PostgreSQL tests (five suites) and every required real host/Kafka/OTLP scenario. Source digest: `37b11e91944eadf9603a7d1adf7cebb394e79652c9883223ce682c29201e93ed`. The ignored `artifacts/phase3-report.json` records the complete gate durations and source identity; generated raw logs are not committed. Exact-patch approval remains pending.

## Publication after exact-patch approval

The owner approved all five manifest-bound patches and requested push. They were committed in order as `5f1b5db`, `abe9941`, `7d5676d`, `77c12c8` and `7651620`, then pushed to `main`. [Hosted CI](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45525531992) completed successfully in all four jobs, including x64 and native ARM64. Earlier preparation/approval wording above records the historical review state rather than authorization for later phase-4 code.
