# Phase 4: offline retrieval and cited execution

Status: prepared against phase-3 head `765162058ade8d48de3fa10775d30715563df05a`, published with successful x64/ARM64 CI. The accepted architecture is ADR-0003 and the corpus/pinning/citation design. The complete local phase-4 gate passed all 16 controls and 52 criteria against frozen sources. These code patches require exact owner approval before commit; previous phase-3 approval does not approve this new diff.

## Proposed logical commits

1. **`feat: execute against immutable scoped corpus evidence`**
   - Add `@lab/knowledge` with deterministic lexical hashing, paragraph/UTF-8 chunking, custom SHA256 UUIDv8 chunk IDs, manifest validation and delivered-evidence citation validation. Reuse the existing pinned Zod version; no embedding/model service or new third-party SDK is introduced.
   - Add additive migrations 13–14 for immutable corpus, profile/snapshot membership, active tenant selection, execution configuration, attempt evidence and result citations. Composite FKs retain provenance; deferred checks prevent answered results without citations or abstentions with citations.
   - Seed only the repository-owned two-tenant corpus. Repeated content is verified, incompatible changes fail atomically, and new versions/snapshots preserve old data. An unchanged older manifest cannot silently move a newer active pointer backwards.
   - Pin configuration in new submission/replay transactions; historical receipts resolve before selecting current configuration. Retries retain their snapshot. Existing jobs without RAG configuration retain the legacy abstention mode.
   - Add exact tenant/snapshot/profile pgvector retrieval, finite defensive-copy cache, live-attempt context/evidence recording and the simulated extractive provider. Completion validates actual delivered references and persists answer/citations/lifecycle atomically. API GET returns immutable references; terminal and generation fencing remain active.
   - Wire scoped dependency manifests/build inputs and the owned fixture into the seed image. Add retrieval spans under execution without capturing question/source text. Include meaningful pure and real SQL tests, updated persistence fixtures and migration upgrades from historical schemas.
2. **`feat: expose cited simulated answers in the CLI demo`**
   - Accept only valid answered/abstained result combinations and bounded unique citation references in the existing client, preserving provider-mode checks, secret redaction and deadline/retry behavior.
   - The demo asks about the indexed retry policy. The separate RAG harness verifies two tenants answering the same question with distinct own-tenant source/citations, unsupported-question abstention, API isolation, durable provenance, retrieval-span parenting and safe default logs. All business writes use HTTP and normal Kafka/executor processing.
3. **`test: measure the versioned offline retrieval baseline`**
   - Thirty static labeled cases bind corpus/source identities, expected chunk IDs, answerability and explicit tuning/holdout splits. The ten paraphrase/multidocument cases include two questions requiring more than one source. The other categories are ten direct, five unanswerable and five adversarial cases.
   - Query actual exact pgvector through the worker role in a disposable project. Publish per-case/split macro Recall@5, misses, candidate confusion and timings with corpus/dataset/source digests, Git base/dirty status and profile/mode identity. Candidate presence is not answer quality. No real-provider usage or cost is invented.
   - The initial measurement was 0.95 with two partial multidocument misses. Source relevance, query text and splits were not changed to hide those misses. Correcting prototype SHA256 chunk identity to the UUIDv8 space updated ID labels only, as required by RFC 9562; the dataset remains a development version pending its first approved commit.
4. **`test: enforce the complete phase four acceptance gate`**
   - Retain all fourteen phase-3 gates and add retrieval measurement plus real cited RAG acceptance. Require 52 unique criteria, valid unskipped/unfocused references, every gate successful and unchanged code/fixture sources.
   - Cross-check the separate retrieval report against the same implementation digest and successful scoped cleanup. Include fixtures and phase-4 evidence in source hashing. Add both new gates to x64 and ARM64 CI; no previous gate is removed.
5. **`docs: record offline evidence and phase four operating limits`**
   - Document actual algorithms, immutable/pinned provenance, updated result/client behavior, read authority, separate evaluation categories, observed misses and legacy behavior. Record the approved/pushed phase-3 base and clearly distinguish new local verification from unrun hosted phase-4 CI.
   - Agent state machines/tools, real providers, semantic-generation evaluation and release remain future work.

Shared manifests/build/root command edits are divided by purpose in the review patch series. Apply the full diffs in order. All new files are included, with affected-file lists, proposed messages and SHA256 identifiers in the external manifest. Preparing those review artifacts does not stage or commit new code.

## Security and compatibility changes

The trusted worker credential now receives question SELECT permission because execution needs the accepted question. The consumer and executor still share that credential, so the process split is not a database credential boundary. Actual context loading requires the current server-owned tenant/job/attempt identity; runtime content updates, active-pointer changes, credential reads and administrative actions remain denied. Earlier denial tests were updated to require content-write denial rather than falsely claim question reads remain forbidden. Tenant/ownership checks are adapter rules plus composite constraints, not tenant RLS against a compromised runtime credential.

Migrations preserve pending outbox bytes, jobs, attempts, credentials and legacy executions. Historical upgrade fixtures now write their original SQL contract instead of using a new application adapter against an old schema. API receipts and event payloads are unchanged. New acceptance requires an available active corpus; an existing same-key receipt can still resolve after active configuration changes. No public upload, search, arbitrary file/URL ingestion, tool or model endpoint is added.

Original source and exact digests remain stored. Only normalized bounded chunks enter context. Ordinary runtime roles cannot change corpus data; the privileged fixed seed module is trusted to enforce immutable membership/version behavior. There is no answer cache, approximate index or claim of semantic embeddings. Cited answers deliberately expose their authorized tenant's source excerpt to that caller; default telemetry remains content-free.

## Validation record

Red: knowledge tests initially failed because the workspace module did not exist. SQL tests then failed at the missing public seed boundary, and provider tests failed at the missing extractive adapter. The custom SHA256 ID-format test caught use of UUIDv5 bits; the implementation now uses UUIDv8. The first evaluation startup used Compose's running-service wait on a successful one-shot seed; it now explicitly waits for seed termination and checks exit status. Existing permission tests also caught the deliberate question-read grant; content-write and credential-denial checks remain active.

Focused green: pure algorithms/validators and the extractive provider; real PostgreSQL seeding, mutation rejection, cache isolation, corpus rollback, pinned retry/replay context, fabricated-citation rejection, retention and result/citation rollback; actual CLI/Kafka/executor answers for two tenants and abstention with safe logs. The combined frozen-source gate's final report supersedes development counts/results.

The [phase-3 hosted run](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45525531992) is green for all four jobs. Hosted phase-4 CI is not claimed until these exact patches are approved and published. See [phase-4 acceptance](../phase4.md) and the [operator guide](../../operations/knowledge.md).

## Final combined acceptance

The complete local run passed with 303 fast tests (22 suites), 205 PostgreSQL tests (six suites), all 16 required gates and all 52 criteria. Exact source digest: `309a7b53ac2ef86091113f91c4cdbbc8dd68e4ac9ea4b24c669eece32c699900`. The separate actual-pgvector ranking report matches that digest, reports Recall@5 = 0.95 on 20 answerable cases (30 total), retains both partial multidocument misses and confirms successful scoped cleanup. New hosted phase-4 CI remains pending publication.

The backend patch passed its isolated format/type/fast check (299 tests, 22 suites) and its separate PostgreSQL run (205 tests, six suites); the CLI patch applied on top passed its check (303 tests, 22 suites). Full diffs also apply in order and reconstruct the final changed/new file bytes. Exact hashes, messages, file lists and validation details are supplied in the external review manifest. No phase-4 code commit has been created before owner approval.
