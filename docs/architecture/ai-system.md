# Retrieval, agent, and tool design

Status: proposed. No corpus, model adapter, tools, or evaluations are implemented. Read with [ADR-0003](../adr/0003-offline-ai-and-evaluation-boundaries.md), [security](security.md), and [runtime limits](runtime-limits.md).

## Corpus and reproducibility

Seed two fictional tenants with distinct API-operation and incident-response documentation, plus deliberately similar vocabulary and tenant-specific sentinel content. Source fixtures live under the proposed `fixtures/knowledge/` directory. Bootstrap only reads the repository-owned fixture manifest; there is no public upload or arbitrary path ingestion endpoint initially.

A corpus manifest identifies document IDs, immutable versions, content digests, tenant membership, and a snapshot ID. Re-running bootstrap with an unchanged manifest is a no-op. Changed content under an existing immutable version is an error, not an overwrite. New documents require a new snapshot/version. Preserve cited snapshots and chunks for execution history.

An active corpus pointer is tenant-scoped. Once RAG is introduced, acceptance of a new execution binds corpus snapshot, retrieval profile, provider mode, and agent-policy version in its transaction. Retries preserve this configuration. Replay may bind the current snapshot as a new generation and records that choice. An unavailable snapshot/profile blocks new acceptance rather than silently changing retry context.

The logical data model must include corpus snapshots, snapshot/document-version membership, tenant active pointers, and the execution configuration references when this phase is implemented. These are planned additions, not permission to migrate the database before architecture approval.

## Chunking and baseline retrieval

Normalize fixture line endings to LF, preserve original immutable source text, and form chunks at paragraph boundaries where possible. Enforce a 2 KiB UTF-8 maximum per chunk; split oversized paragraphs on code-point boundaries with at most 128 bytes of overlap. Chunk IDs derive from document/version, ordinal, and content digest. The versioned chunking profile must make re-ingestion deterministic.

Offline profile `lexical-hash-v1` lowercases text, extracts ASCII alphanumeric tokens, hashes each token with SHA-256, maps the first unsigned 32-bit big-endian word modulo 128 to a vector coordinate, accumulates token counts, and L2-normalizes nonzero vectors. No semantic-model claim is made. Empty token sets return no candidates rather than attempting cosine distance on a zero vector.

For the small corpus, use exact cosine similarity in pgvector over only the authorized tenant, pinned snapshot, and compatible profile. Return at most five chunks, ordered by score descending and chunk ID ascending for ties. An initial score cutoff of 0.25 is a tuning hypothesis, not a measured quality result; record changes with evaluation evidence. Never filter another tenant's results only after retrieving them into model context.

A real embedding profile has its own model ID, dimensions, preprocessing version, and compatible storage/query path. It cannot reuse offline vectors. Do not add approximate indexes before measured query plans and recall evidence justify them. Cache keys include tenant, snapshot, profile, query digest, and relevant policy version; the initial design does not cache generated answers.

## Agent execution

Use a small state machine: prepare scoped context, request a model decision, validate a tool request or final answer, execute an allowed tool, then continue until a final answer or a budget boundary. Do not add open-ended planning, recursive agents, dynamic plugins, or a general workflow framework.

The initial retrieval supplies authorized evidence even if the model never asks for another search. The scripted provider follows fixture-defined decisions through the same validators and tool executor. Its determinism is useful for failure tests, not evidence of autonomous reasoning.

A model decision is exactly one tool invocation or one final-answer object. Reject unknown variants, extra arguments, malformed structures, and oversized results. Do not execute arbitrary text as code or accept a provider's tool name without checking the allowlist. Tools execute serially so budgets and evidence ordering remain understandable.

Final-answer objects contain outcome, answer, and citation references. `answered` requires citations drawn from evidence actually delivered to this attempt, with tenant/snapshot/version consistency. `insufficient_evidence` requires no citations and an explanatory abstention. These structural checks cannot prove semantic support for every sentence; the evaluation suite measures that separately.

Provider errors map to safe internal classifications. No model-generated instructions can change permissions, provider endpoints, deadlines, or corpus selection. Attempt fencing remains required after a provider call, including a successful one.

## Fixed read-only tools

All argument objects reject unknown fields. Tenant/principal context is injected by the executor and is never an argument the model can choose.

| Tool | Arguments | Result and authorization |
| --- | --- | --- |
| `search_documentation` | `query`: trimmed nonempty string, at most 500 code points | Up to five chunks from the pinned authorized snapshot; uses the same retrieval profile and context limits |
| `get_service_status` | `serviceId`: one of the seeded allowed IDs | Fictional tenant-owned status and timestamp; unknown or other-tenant IDs return a non-disclosing not-found result |
| `get_ticket` | `ticketId`: UUID | Own-tenant ticket lifecycle fields only; excludes message, generated answer, and raw attempts to avoid recursive content expansion |

Tool access is a system capability scoped to the accepted ticket tenant, not a fresh HTTP login using the submitter's secret. Submitted work survives subsequent credential revocation as documented in the security policy. A tool cannot replay, create, cancel, send messages, retrieve arbitrary URLs, read files, or execute shell commands.

Errors contain safe codes such as `INVALID_ARGUMENTS`, `NOT_FOUND`, `TOOL_FORBIDDEN`, `TOOL_TIMEOUT`, and `DEPENDENCY_UNAVAILABLE`. The executor maps them to terminal or transient attempt outcomes using the shared runtime policy; there are no hidden tool/SDK retry loops.

## Evaluation plan

Keep three report categories separate:

1. Workflow: scripted execution, budgets, idempotency, failure recovery, and security boundaries.
2. Retrieval: ranking against labeled chunk/document evidence, separately for lexical and real embedding profiles.
3. Generation/agent: real-provider answer support, abstention, citation validity, and expected/forbidden tool behavior.

Start with 30 versioned cases: 10 direct questions, 10 paraphrases/multi-document questions, five unanswerable questions, and five adversarial cases. Cases identify tenant, corpus digest, expected evidence, answerability, and allowed tool behavior. Add more cases when a defect exposes a gap. Do not tune solely against the fixed holdout subset; identify tuning and holdout cases explicitly.

Report retrieval Recall@5 (fraction of labeled relevant chunks retrieved per answerable case, then macro-average), citation-reference validity, abstention confusion counts, forbidden tool attempts/executions, latency, and provider usage where available. Unsupported semantic claims require a documented rubric and human review; model-judge scores, if added, are auxiliary and name their judge/configuration.

Initial deterministic gates: all structural citation and tenant checks pass; no forbidden tool executes; all scripted budget/recovery assertions pass. The provisional offline retrieval target is macro Recall@5 >= 0.80 on the labeled answerable fixture set; it must be measured, not assumed. Missing results mean not evaluated. Real-model semantic pass thresholds require rubric calibration on the actual corpus and are a release gate only for the optional real-provider feature.

Reports include Git revision, corpus/dataset digests, case IDs, retrieval/profile/policy versions, provider/model identifiers, run mode, sample count, failures, timings, and usage completeness. Keep failures visible and never invent cost for responses lacking usage metadata.

## TDD acceptance additions

- AI-01: identical fixture content yields identical chunks, digests, and offline vectors.
- AI-02: changing a stored immutable document version is rejected.
- AI-03: cross-tenant sentinels never reach retrieval context, tools, citations, or answers.
- AI-04: cached retrieval cannot cross tenant, snapshot, or profile boundaries.
- AI-05: unknown tools, extra arguments, and fabricated citations fail before persistence.
- AI-06: zero-evidence inputs abstain; budget exhaustion terminates without extra calls.
- AI-07: retries use the pinned execution configuration; replay records its newly selected configuration.
- AI-08: scripted and real-provider reports remain separately labeled and cannot satisfy each other's quality gates.

Only the offline lexical/scripted mode is required for the credential-free release. Before adding a real adapter, review provider/model choice, data handling, SDK retry behavior, token controls, and licensing/cost implications in its focused implementation patch.
