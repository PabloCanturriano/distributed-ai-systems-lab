# Phase 5: bounded offline execution and acceptance

Status: full offline implementation prepared against published head `482ff3777251d06b2b93d4bb17b90f60d2455097`. This supersedes the earlier library-only four-packet proposal; none of those unapproved code patches was committed. The accepted architecture remains ADR-0003 and the bounded agent/tool design. No live provider or new dependency is added. The [complete acceptance record](../phase5.md) tracks final verification.

## Proposed logical commits

1. **`feat: bound offline agent decisions and tool execution`**
   - `apps/worker/src/bounded-agent.ts` and `tests/bounded-agent.test.cjs`.
   - Initial scoped evidence, strict tool/final union, fixed allowlist, four model turns, three serial tools and finite model/tool/attempt deadlines. Validate every delivered chunk and citation, reject context/output overflow and stop after cancellation or budget exhaustion. Do not evict earlier evidence or truncate structured arguments.
   - Simulated mode is explicit; fixed fixture decisions never interpret source text as commands. Errors contain safe codes/classifications. Summaries exclude questions, arguments, source and results.
2. **`feat: add scoped read-only agent tool adapters`**
   - `apps/worker/src/agent-tools.ts` and `tests/agent-tools.test.cjs`.
   - Bind tenant/snapshot once in trusted composition; exact retrieval includes the selected policy in cache identity. Catalogue reads validate/copy a bounded host-owned fixture; unknown and foreign service IDs share the same result. Ticket reads use parameterized tenant-filtered SQL under the worker role, with one-second lock/statement limits, and expose only current-generation lifecycle fields.
3. **`feat: execute pinned bounded agents with atomic results`**
   - Add the fixed offline provider and owned service catalogue; compose it in the executor image. Preserve legacy and extractive dispatch. New activation only advances the active policy, preserves accepted configurations and refuses downgrade/rewind. Migration 15 admits the new policy and adds checked bounded summaries without rewriting old work.
   - Refactor the existing immutable evidence insert for use inside completion. After live generation/token/lease checks, verify the pinned policy and atomically persist evidence, result, citations, summary and lifecycle. Database checks reject mismatched result policy and malformed summary fields, names, counters or extra content.
   - Add safe API/CLI policy, turn and tool output with legacy compatibility. Add model/tool spans, preserve initial/tool retrieval correlation and exclude all raw inputs/results. Update normal-runtime host expectations and execute the actual agent in the response-before-persistence crash actor.
   - Include all vertical-slice code, Docker inputs, shared schema, real SQL/migration/rollback/retry/replay tests, provider security tests, CLI contracts and affected existing host harnesses. The external manifest lists every file in this larger integration commit.
4. **`test: evaluate versioned scripted agent workflows`**
   - Add the twelve-case owned workflow dataset, `scripts/agent-workflow-eval.mjs` and `evaluate:workflow` command. Cases cover cited/abstained results, serial calls, unknown names, forged scope, fabricated references, budgets, foreign evidence, oversize queries and injected source instructions.
   - Record Git/source/dataset identities, explicit scripted fixture backend, safe outcomes, forbidden requests versus actual execution and timings. Provider usage is inapplicable and semantic quality remains unevaluated.
5. **`test: enforce the complete phase five acceptance gate`**
   - Add the 59-criterion manifest and seventeen-control runner. Retain every previous layer and validate workflow/retrieval report identity against unchanged sources. Include the new manifest in source digests and add workflow evaluation to both CI architectures.
6. **`docs: record offline agent completion and operating limits`**
   - Record actual activation, fixed simulation behavior, atomic persistence, compatibility, tool authority, API/CLI summaries, trace/privacy boundaries, phase-four publication and phase-five acceptance. Distinguish local verification from new hosted CI, live-provider quality and release status.

Shared root command edits are split by purpose in the full patch sequence. All new files and complete diffs are included. Earlier library-only patches are not approval of this revised integration patch. No code is staged or committed by preparing the review artifacts.

## Security, migration and compatibility

Migration 15 extends existing policy checks and adds nullable `agent_summary` for old results, a strict size/shape predicate and deferred result-policy consistency. Worker INSERT and API SELECT grants cover only that added result column; no new login/role, tenant authority, public endpoint or runtime network capability is added. Upgrade tests include the phase-four schema and preserve prior payloads, jobs, attempts and identities.

The fixed initializer activates `bounded-agent-v1` only for subsequent acceptance/replay. Retries use their original configuration. A previously accepted extractive job still uses its old provider after activation; a later replay records the new policy. Legacy jobs with no corpus binding retain original abstention. Completed old result shapes remain readable.

Tools are read-only system capabilities scoped to accepted work, so revoking the submitter does not cancel that work. Ticket content, answers and raw attempts never enter the ticket tool. Service observations are fictional image-owned data, not remote probes. The existing shared worker credential is a trusted module boundary, not SQL isolation between consumer/executor or tenant RLS.

The fixed offline model performs another bounded documentation search when the question fits the argument limit, reads its ticket, reads the tenant's allowed support service and returns a documentary extract/abstention. It skips the extra search for longer questions without truncating them. No recursive/dynamic planning or document-controlled authority is introduced. Structural citations do not prove semantic support.

## Validation record

Red: the initial library and service behaviors failed at their missing implementations. Integration exposed an unauthorized ticket timestamp read; the query uses the permitted generation timestamp without widening grants. The activation test then confirmed that the missing transition left new work extractive. Strict scope validation also caught passing the entire loaded context to a scope-only tool constructor; composition now supplies only tenant/snapshot. Application tests caught synchronous validation expectations separately from transactional failures.

Focused green: 345 fast cases across 25 suites, including nine additional provider/CLI contracts beyond the initial 336-case slice; activated end-to-end RAG passed with two tenant-separated cited answers, one abstention, durable summaries and correlated model/tool/retrieval spans. The complete run passed all 215 PostgreSQL cases in six suites, including activation, atomic rollback, lost ownership/retry, policy replay and direct malformed-summary predicates. The final frozen-source run passed all seventeen controls and 59 criteria, with the same 345 fast tests and 215 SQL cases, twelve scripted cases, macro Recall@5 of 0.95 and zero forbidden tool executions. Source digest: `2f5d740f902750f89e37f4209f4f43715a93f7e252591f5d0690c4688268dd77`. See the acceptance document for exact environment, failures retained from the first run and limitations.

Model/tool deadlines use fake clocks and explicit in-flight checkpoints. SQL lease tests use database time. The crash harness pauses after a real agent response containing documentary evidence, kills the actor before persistence, observes real lease expiry and verifies recovery under a different token. No arbitrary sleep is used to establish the race.

## Remaining outside offline phase five

A real-provider adapter still requires provider/model, outbound/data handling, token/cost, SDK retry and license review plus separate live evaluation. It is optional for the credential-free release. Phase-six release preparation, measured prerequisites and owner-selected publication policies remain separate. Local passing code is not hosted phase-five CI or a release.

## Investigation note: OBS-CLI-01

The first complete run passed thirteen controls, then the existing collector-outage scenario failed while its CLI waited for the fourth ticket (exit 4). That harness originally discarded the CLI error code and container/job state during cleanup, so the retained first failure does not establish a root cause. Safe diagnostics now report only command/error code, container status/exit/OOM state and job status/attempt/failure code; no request, result, credential or raw exception text is added.

Two subsequent isolated executions with those diagnostics passed the same strict outage scenario. They do not prove a behavioral fix: no business implementation or assertion was relaxed, and the original cause remains unclassified. The mandatory scenario is retained in the final complete run and in both CI architectures. This is tracked as `OBS-CLI-01` for investigation before phase-six release; it is not quarantined or silently retried by the gate. Initial failed-run evidence is preserved with the review artifacts.
