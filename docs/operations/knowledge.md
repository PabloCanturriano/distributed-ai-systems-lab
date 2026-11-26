# Offline corpus, retrieval and cited simulation

Status: phase-four retrieval is published; the working-tree phase-five executor adds bounded offline tools and atomic agent completion under ADR-0003. See [phase-five evidence](../quality/phase5.md) for verification and review status. No real model or embedding service is called.

## Reproduce the local workflow

The normal seed reads only `fixtures/knowledge/corpus-v1.json` in its image after fictional identities are provisioned. It atomically creates immutable document versions/chunks/embeddings, snapshot membership and the active tenant profile. Repeating the same manifest verifies stored bytes and vectors; changed bytes under an existing version/snapshot fail rather than overwrite. A new version/snapshot preserves prior data. Starting an old manifest against a different active snapshot fails rather than silently moving the pointer backwards.

```sh
docker compose build cli
docker compose --profile messaging --profile execution up --build --detach --wait --wait-timeout 180
docker compose run --rm --no-deps -T cli demo --identity harbor.requester --json
```

The demo asks about retry policy and returns a **simulated extract** with an immutable citation. Try the same question using `summit.requester`: its content and references come from Summit, despite similar vocabulary. An unsupported question completes with explicit abstention:

```sh
docker compose run --rm --no-deps -T cli ticket create --message 'orbital telescope aperture' --key unsupported-review-1 --json
docker compose run --rm --no-deps -T cli ticket wait <returned-ticket-id> --json
```

These are fictional fixtures. An `answered` extract establishes structural evidence provenance, not semantic understanding or real-model quality. The policy requires two distinct query-token overlaps before quoting a retrieved chunk; this conservative scripted rule is not a calibrated answerability classifier.

## Immutable identity and execution context

Original source text and SHA256 digest are preserved. Chunking normalizes CRLF/CR to LF, packs paragraphs, and splits oversized paragraphs on Unicode code-point boundaries into at most 2KiB UTF-8 chunks with at most 128 bytes of overlap. Chunk IDs include document/version, ordinal and content digest in a deterministic SHA256-derived UUIDv8 layout, following the custom-hash space in [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.8). The chunking profile is `paragraph-utf8-v1`.

`lexical-hash-v1` lowercases text, extracts ASCII alphanumeric tokens, hashes tokens with SHA256, maps the first big-endian unsigned 32-bit word modulo 128, counts and L2-normalizes. Empty token sets produce no candidates. Exact pgvector cosine search materializes only the authorized tenant, pinned snapshot and profile before ranking. It returns at most five chunks at score >=0.25, breaking ties by chunk UUID. This is lexical hashing with collisions, not semantic embeddings; no approximate index is added.

The process cache retains at most 32 query entries for one monotonic second. Its key includes tenant, snapshot, profile, policy and query digest. Entries contain at most five bounded chunks and callers receive defensive copies. No generated answers are cached.

A new submission/replay transaction pins snapshot, retrieval profile, the active policy and provider mode. The initializer activates `bounded-agent-v1` for new work while existing `extractive-simulated-v1` configurations remain unchanged. Missing active configuration rejects new acceptance without partial rows; same-key historical receipts still resolve. Retries use the original configuration after the active corpus changes. Replay selects the current active profile for its new generation. Existing executions created before this migration keep the original abstention behavior; startup never binds them retroactively to a new corpus.

## Evidence and persistence

The executor loads question/configuration only for its server-owned current job/attempt and unexpired lease. Retrieval occurs outside ownership locks. For bounded-agent execution, the engine keeps delivered chunks in bounded memory until completion. A ticket-first transaction then checks live ownership and persists exact evidence together with the result. The older extractive provider retains its original evidence-recording path. Cancellation or stale ownership cannot complete new results.

Completion permits citations only from that attempt's recorded evidence. Composite foreign keys bind tenant, execution, attempt, chunk/version, snapshot membership and embedding profile. For new agent executions, evidence, answer, citations, bounded tool summary, attempt/job and lifecycle commit together. Deferred constraints require at least one citation for `answered` and none for `insufficient_evidence`. Foreign/fabricated references fail before durable completion; referenced versions/chunks cannot disappear. Earlier attempts, corpus versions and result evidence remain stored.

The shared trusted worker role now has question SELECT permission for execution, alongside corpus reads. The consumer process does not read questions, but its shared credential is not a SQL isolation boundary from the executor. Content updates, active-corpus changes, credential reads and administrative actions remain denied. Tenant/ownership scoping is enforced by trusted adapters and composite references; this is not tenant RLS or protection against a compromised worker credential.

No question, source excerpt, answer or raw provider exception is added to default logs/spans. `retrieval.search` is a child of the execution span with safe ticket/attempt metadata. Authorized CLI/API results deliberately contain their tenant's quoted source text and citation IDs.

## Separate evaluation

Use Node 24.22.3 and Docker for host gates:

```sh
npm run evaluate:retrieval
npm run test:rag
npm run test:phase4
```

The retrieval dataset has 30 versioned cases: 10 direct, 10 paraphrase/multidocument, five unanswerable and five adversarial. Its labeled source/chunk IDs, corpus digest and tuning/holdout assignments are fixed before measurement. Reports retain misses and separate each split. Replacing prototype chunk ID formatting with UUIDv8 changed ID labels only, without changing question text, document relevance or split membership after the first measurement.

`artifacts/retrieval-v1-report.json` records corpus/dataset/source digests, Git base/dirty status, exact profile, per-case Recall@5, split summaries, candidate confusion and timings. Candidate presence is not semantic answerability or generation quality. The 0.80 target remains a hypothesis whose measured result is reported explicitly. Retrieval success cannot stand in for a real-provider answer evaluation or the future agent/tool suite.

The actor queries actual pgvector through the worker role in an isolated disposable project. It never prints question/source content or credentials. The RAG gate separately checks authenticated CLI → Kafka → executor → cited result, tenant isolation, abstention, durable evidence references, retrieval-span parenting and safe logs. Cleanup removes only each harness's generated project.

## Bounded offline agent

New executions use a fixed simulated workflow with initial scoped retrieval, at most four model decisions and three serial read-only tools. `search_documentation` reuses the pinned corpus; `get_ticket` returns tenant-owned current-generation lifecycle fields only; `get_service_status` returns a timestamped fictional observation from the owned `services-v1.json` catalogue. These tools expose no URLs, files, shell, writes or credential access. Missing and foreign IDs are non-disclosing `NOT_FOUND` results.

The result's `execution` object records safe tool names/outcomes, `policy: bounded-agent-v1` and `modelTurns`. It excludes arguments and tool results. Initial retrieval does not consume a model-selected tool call. Questions longer than the 500-code-point search-tool limit keep initial retrieval and skip the extra search. Service fixtures are not live health probes; the scripted answer remains a documentary extract or abstention.

Run `npm run evaluate:workflow` for the separately labeled twelve-case deterministic workflow report, or `npm run test:phase5` for complete local acceptance. Neither report establishes real-model semantic quality.
