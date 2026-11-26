# Phase 5: bounded offline agent acceptance

Status: the offline implementation is locally complete in the working tree. All seventeen controls and 59 criteria passed against unchanged implementation/fixture sources on 2026-11-25. The published base is phase-four head `482ff37`, with successful x64/ARM64 CI. The approved source was committed and pushed through `c3b304c` in nine smaller commits without changing the reviewed final tree. Hosted phase-five CI is tracked separately from local acceptance.

## Implemented behavior

- The executor selects the pinned policy: legacy abstention, phase-four extractive simulation, or the new `bounded-agent-v1` workflow. Seed activation affects future acceptance/replay, not accepted configurations.
- Initial authorized retrieval precedes at most four strict simulated model decisions and three serial read-only tools. Fixed deadlines and byte bounds apply; malformed output, fabricated citations, forbidden tools and exhausted budgets fail safely.
- Documentation search uses the accepted tenant/snapshot/profile/policy. Ticket lookup exposes current-generation lifecycle fields only. Service status uses an image-owned, tenant-scoped fictional catalogue, with no remote probes.
- Agent execution does not write evidence before completion. Under live generation/attempt/lease fencing, one transaction commits evidence, citations, result, safe summary and lifecycle. Failures roll back all of them; abandoned responses cannot persist.
- API/CLI return bounded tool names/outcomes and counters without arguments, raw results or exceptions. Manual model/tool/retrieval spans retain the execution trace and exclude content.
- Fixed workflow reports remain separately labeled from lexical retrieval and real-model semantic quality. The optional live provider is not implemented or required for the credential-free offline phase.

## Complete gate

Run `npm run test:phase5`. It retains all sixteen phase-four controls and adds `evaluate:workflow`, with 59 unique criteria in [the acceptance manifest](phase5-acceptance.json). The runner rejects missing/focused/skipped references, any failed child command, source changes during verification, or inconsistent report identities.

The report is `artifacts/phase5-report.json`. Retrieval evidence is separately recorded at `artifacts/retrieval-v1-report.json`; scripted workflows use `artifacts/agent-workflow-v1-report.json`. Both must identify the same source/fixture digest as the complete run. No generation-quality score or invented provider usage is reported.

| Family               | Evidence                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Previous 52 criteria | All phase-four controls remain required, including real Kafka, SQL, CLI, tracing, repair and recovery                             |
| AI-05                | Strict decisions, allowlisted tools and actual-delivered citation validation, including atomic SQL rollback                       |
| AI-06                | Zero-evidence abstention, fake-clock model/tool/attempt deadlines, parent abort and no extra calls after budget exhaustion        |
| AI-08                | Explicit simulated adapter mode and separately labeled twelve-case workflow report                                                |
| SEC-06/07            | Injected document instructions, unknown tools, forged authority, URLs, oversized results and invalid summaries fail closed        |
| SEC-08               | Instrumented fake exceptions/request data excluded from safe errors and telemetry; actual RAG logs exclude corpus and credentials |
| SEC-09               | HTTP revocation rules remain active while accepted tenant-scoped system work survives submitter revocation                        |

## Actual verification

`npm run test:phase5` passed all **17 controls and 59 criteria** on Node 24.22.3, Darwin/arm64, using Docker Linux/arm64. The final run included **345 fast tests in 25 suites**, **215 real PostgreSQL tests in six suites**, the full CLI/Kafka/agent/recovery/tracing journeys and **12 of 12 scripted workflow cases**. This adds 42 fast and ten SQL cases to the published phase-four record.

The frozen implementation/fixture digest is `2f5d740f902750f89e37f4209f4f43715a93f7e252591f5d0690c4688268dd77`. Retrieval macro Recall@5 remained **0.95**, with the same partial misses `1-paraphrase-rollback` and `2-paraphrase-backup`. Workflow evaluation observed two forbidden requests and zero forbidden executions; no semantic quality or provider usage was inferred. All three reports identify the same sources. Total child-control duration was 957,114 ms.

The final complete run passed the strict collector-outage scenario. The initial unclassified exit-4 failure remains recorded as `OBS-CLI-01`; passing subsequent runs is not described as a proven causal fix.

The response-crash scenario now obtains nonempty documentary evidence using the real offline agent, pauses before completion, is killed, waits for the real 30-second lease and repeats read-only work under a new attempt. It requires the abandoned attempt to leave no durable evidence or result, validates the recovered cited answer and summary, and rejects the old token.

## Review and limits

See [review 0026](reviews/0026-bounded-offline-agent.md) for logical patch groups, actual validation and migration/authority details. This phase does not establish real-model reasoning, semantic answer quality, live service health, hosted phase-five success or a release. The fixed model always follows its bounded script and quotes documentary evidence; tool observations are context, not a separate basis for unsupported answered text.

The worker is a trusted module credential, not tenant RLS. Cancellations cannot guarantee a dependency stops immediately, so persistence remains fenced after calls. Attempts can repeat safe read-only external work. No write tools, arbitrary URLs/files/shell, recursive agents, new credentials or third-party SDKs are introduced. Phase 6 covers release preparation, remaining operational evidence and owner-selected release policies.

### Recorded investigation: OBS-CLI-01

The first complete run failed in the collector-outage CLI wait with exit 4, without retaining enough diagnostics to classify the cause. Two isolated runs with new sanitized diagnostics passed unchanged assertions. The original cause is not claimed fixed. The strict scenario remains mandatory in the complete gate and both CI architectures; its initial failed report is preserved. See [the investigation record](reviews/0026-bounded-offline-agent.md#investigation-note-obs-cli-01). This incidence must be classified before phase-six release preparation is considered complete.
