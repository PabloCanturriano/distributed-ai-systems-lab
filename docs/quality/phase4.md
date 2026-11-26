# Phase 4: offline retrieval and evidence

Status: locally complete. All 16 gates and all 52 criteria passed against unchanged sources on 2026-11-24. The owner approved the exact five implementation patches; they are committed and pushed through `482ff37`. Phase 3 was approved, committed and pushed through `7651620`, with [successful x64/ARM64 CI](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45525531992). The [published phase-4 CI run](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45535949637) is separate from this local record.

## Delivered behavior

- Repository-owned fictional corpus for two tenants, immutable source/version/snapshot identities, deterministic Unicode-safe chunks and 128-dimensional lexical hashing.
- Exact, scoped pgvector retrieval and a finite cache that separates tenant, snapshot, profile, policy and query identity.
- Transactional configuration pinning for new generations, retained configuration on retries, new selection on replay and compatibility for previously accepted legacy jobs.
- Live-attempt context/evidence recording, structurally validated simulated extracts, immutable citation references and atomic answer/citation/lifecycle persistence.
- CLI support for cited answers, an evidence-backed simulated demo, actual retrieval trace parenting and source/credential exclusion from default telemetry.
- Frozen 30-case retrieval labels with separate tuning/holdout reporting and honest failure lists; a distinct real end-to-end RAG gate.

[Operation and design details](../operations/knowledge.md) describe algorithms, role changes, commands and limitations. These are extractive scripted responses with references, not real-model generation or agent reasoning. Tools, live providers and semantic-generation quality remain phase 5.

## Complete gate

`npm run test:phase4` retains the fourteen phase-3 gates and adds `evaluate:retrieval` plus `test:rag`. It requires all 52 unique criteria in the [manifest](phase4-acceptance.json), executable references without skip/focus, every child command to succeed and unchanged implementation/fixture sources. The retrieval report must match the same source digest and record successful scoped cleanup.

The acceptance report is generated at `artifacts/phase4-report.json`; the separate retrieval report is `artifacts/retrieval-v1-report.json`. They contain source identity, environment, gate durations and measured outcomes without raw questions, document content or credentials. A future code or fixture edit requires a new run. Local success is not hosted phase-4 CI or a release.

| Family                                             | Evidence                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase-3 HTTP/EVENT/DATA/CLI/REC/OBS and SEC-01..03 | All existing gates retained; updated schema upgrade and fixture boundaries remain explicit                         |
| AI-01..04                                          | Pure algorithm tests, actual PostgreSQL immutability, tenant/snapshot/profile scope and cache isolation            |
| AI-07                                              | SQL acceptance/receipt atomicity, retry after corpus activation and generation replay with selected configuration  |
| DATA-08                                            | FK retention, delivered-evidence references and deferred answer/citation consistency                               |
| RESULT-01                                          | Explicit abstention with empty citations for unsupported evidence                                                  |
| SEC-04, SEC-05, SEC-14                             | Server-owned context, adversarial tenant/cache cases, role/column denials and no public ingestion/search authority |

Initial evaluation measured macro Recall@5 of 0.95 across 20 answerable cases (30 total), with two partial multidocument misses. The final report against frozen sources takes precedence over that development measurement. No score is called semantic answer quality.

## Final local verification

`npm run test:phase4` passed all 16 gates and 52 criteria, with 303 fast tests in 22 suites and 205 PostgreSQL tests in six suites. This adds 11 fast tests and 16 SQL cases to the published phase-3 record; the separate host scenarios and 30 ranking cases are additional to those Jest totals.

Implementation digest: `309a7b53ac2ef86091113f91c4cdbbc8dd68e4ac9ea4b24c669eece32c699900`. Base revision: `765162058ade8d48de3fa10775d30715563df05a`. Recorded environment: Node 24.22.3, darwin/arm64, dirty working tree; total gate execution 845555ms. The separate retrieval report matches the same digest and records successful cleanup. These are local prepared-code results, not newly published phase-4 CI.

The frozen 30-case run measured macro Recall@5 = 0.95 across 20 answerable cases. Both tuning and holdout sets contain ten answerable cases, with their individual scores recorded in the report. The provisional 0.80 target was met on this fixture set. Partial misses remain visible: `1-paraphrase-rollback` and `2-paraphrase-backup` each retrieved only part of their labeled multidocument evidence. This is not semantic-generation accuracy.

Corpus digest: `0743bb12b770b026a489f0e8be4ca5fdd2e6f0b2933a3607870705504a62e1e7`. Dataset digest: `b3da723bdd7a67c43759f8e863fe7af4f30684ff9d862acd34c9357d6690342a`. The exact labels, questions, split assignments and per-case retrieved IDs are versioned with the review.
