# Phase 2: complete simulated ticket workflow

Status: locally complete and prepared for final owner review. All 11 mandatory gates passed on 2026-11-24, with 19 acceptance criteria and trace correlation covered. The completed report records an unchanged implementation digest; a published release or new hosted-CI success is not implied. The accepted phase-2 exit criteria remain unchanged. See the [machine-readable evidence map](phase2-acceptance.json) and [closure review](reviews/0023-phase2-closure.md).

## What this phase delivers

- Containerized CLI demo, submission, current-generation reads and bounded wait, using only the authenticated API.
- Tenant/role checks and scoped idempotency, including concurrent requests, conflicting input, uncertain acknowledgement and stable historical receipts.
- Atomic ticket/execution/receipt/outbox writes; real relay publication; Kafka transport; durable consumer inbox/job handoff before broker offset commit.
- Current-generation execution ownership, database-time leases and fencing, automatic simulated persistence and safe terminal reads.
- Manual OpenTelemetry correlation from HTTP through publication, actual Kafka headers, admission and a detached executor, with durable optional origins and safe local span output.
- Explicit evidence for every phase-2 acceptance criterion and the initial authentication/tenant-role subset. Replay is an already implemented phase-3 slice retained as a regression gate.

The provider is still deterministic: it returns a simulated `insufficient_evidence` answer with no citations/tools. No retrieval, real-model quality, high availability or production readiness is established.

## Acceptance evidence

| Criterion         | Verification                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| HTTP-01           | Real authenticated acceptance; SQL asserts one ticket/execution/receipt/outbox transaction.                                |
| HTTP-02           | Explicit SQL uniqueness checkpoint and real concurrent HTTP same-key requests.                                             |
| HTTP-03           | Changed validated input conflicts without a new ticket or event.                                                           |
| HTTP-04           | Real 202 response body deliberately discarded, completion observed, same-key receipt recovered; separate lost-COMMIT test. |
| HTTP-05           | Foreign/missing reads and replay match 404 without mutation.                                                               |
| EVENT-01          | SQL and real broker redelivery retain one inbox effect and one generation job.                                             |
| EVENT-02          | Distinct valid event IDs for one generation cannot replace durable work.                                                   |
| EVENT-03          | Host-killed SQL-before-offset checkpoint during a broker-observed rebalance; durable redelivery and offset inspection.     |
| DATA-01           | Real PostgreSQL trigger failure after each submission write leaves no partial rows.                                        |
| DATA-02           | Composite tenant FKs reject mismatched creators/executions/admitted work.                                                  |
| DATA-03           | Concurrent claims leave one active token and one consumed attempt.                                                         |
| DATA-04           | Database-time expiry rejects stale renewal/completion; a replacement completes. Controlled expiry is labeled.              |
| CLI-01            | Empty-volume image-built journey without external model credentials.                                                       |
| CLI-02            | Stable generated key across transport failure, including a real cut response body.                                         |
| CLI-03            | Final stdout parses as one JSON object; progress stays on stderr.                                                          |
| CLI-04            | Execution failure/assertion, transport and deadline have distinct exits.                                                   |
| SEC-01            | Initial opaque bearer checks, malformed/missing credentials and revocation/expiry/disabled identity checks.                |
| SEC-02            | Reader/requester mutation restrictions and tenant-scoped operators, including replay.                                      |
| SEC-03            | A requester reads another member's same-tenant ticket; a foreign tenant receives the missing-resource response.            |
| Trace correlation | Exported parent/span IDs prove HTTP → relay → real Kafka header → consumer → executor continuity across worker restarts.   |

Each row's concrete files/assertions and required gates are recorded in the JSON map. Referencing a file does not make a scenario pass: all mandatory commands must finish successfully. The gate rejects a missing/duplicate criterion, unresolved evidence selector, focused/skipped referenced tests, failed subprocess or implementation-source changes during the run.

## Reproduce the verification

With the repository's Node 24.22.3-or-newer 24.x runtime and a compatible Docker/Compose environment:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:phase2
```

The fixed sequence runs format/types/unit checks, real PostgreSQL, the new trace journey, images, Compose, Kafka, relay, consumer, executor, CLI and replay. Docker suites run sequentially, use isolated project/container identities and clean only their owned resources. No application receives a Docker socket. A missing Docker runtime or unavailable required gate is a failure, not a skip.

At completion, `artifacts/phase2-report.json` contains the base revision, implementation/test/config source digest, dirty-tree flag, Node/platform/architecture, gate durations/results and criterion coverage. It contains no raw logs, credentials, questions or answers and is ignored by Git/Docker input. It is a completed-run record, not a live progress file: an older report is not proof for changed source. Keep its digest/revision together with the review evidence. Full environment/image pins and execution limits are recorded in the closure review.

For a Docker-only demonstration, use the [CLI guide](../operations/ticket-cli.md). Running the demo alone does not establish concurrency/crash acceptance. To inspect one trace, use the [phase-2 tracing guide](../operations/trace-correlation.md).

## Next phase

Phase 3 still needs quarantine inspection/repair, full Collector/Jaeger/Prometheus wiring, backlog/retry metrics, export-loss instrumentation and the remaining recovery/observability acceptance families. SDK/manual log correlation in phase 2 is not a claim that those services or dashboards exist. Phase 4 adds tenant-filtered corpus retrieval and evidence; phase 5 adds tools/agent behavior and optional real-provider evaluation; phase 6 closes release evidence and publication.
