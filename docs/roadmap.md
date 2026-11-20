# Implementation roadmap and acceptance gates

Status: phase 1 is in progress after architecture acceptance on 2026-11-16. Runtime, startup configuration, and application image slices are committed. Database identity foundation and persistent fictional identity seeding are committed; the Compose initialization foundation is committed; [API dependency readiness](quality/reviews/0007-api-readiness.md) is committed; the [Kafka foundation](quality/reviews/0008-kafka-foundation.md) is committed; the [client compatibility evaluation](quality/reviews/0010-kafka-client-compatibility.md) and foundation CI are committed. The first phase-2 slice, [atomic ticket submission](quality/reviews/0011-ticket-submission.md), is committed. [Authenticated HTTP submission](quality/reviews/0012-authenticated-ticket-http.md) is committed; [queued/processing status reads](quality/reviews/0013-ticket-reads.md) are prepared for review. No complete ticket-processing workflow has passed yet.

## Phase 0: architecture review

Deliverables: component boundaries, HTTP/events, logical data model, threat model, execution limits, AI/tool contracts, CLI journey, ADRs, test strategy, and operation/release plans.

Exit: owner reviews the complete design and explicitly authorizes implementation. Remaining provider-specific choices are deferred to their optional feature, not silently assumed. Exact dependency patches and compatibility evidence are recorded in the first relevant implementation patch. License and private reporting setup require owner selection before the working public release.

## Phase 1: executable foundation

Deliverables: npm workspaces, API/worker entry points, reviewed Docker/Compose setup, role bootstrap, ordered migrations, fictional seeds, health probes, structured safe logs, and baseline CI. Include only packages required by this slice.

Exit: OPS-01, OPS-02, OPS-03, OPS-06 and relevant security checks pass. A clean Docker-only startup works without an external key. Dependency versions, broker/client compatibility, test runtime, startup time, and resource observations are recorded. Startup commands become a verified README quickstart only after this evidence exists.

## Phase 2: one complete ticket workflow

Deliverables: CLI submission/read/wait, scoped idempotency, ticket generations, outbox, consumer inbox/job handoff, executor ownership, and a minimal deterministic result. No bypass directly schedules a ticket around Kafka.

Exit: HTTP-01 through HTTP-05, EVENT-01 through EVENT-03, DATA-01 through DATA-04, CLI-01 through CLI-04, and initial tenant/role checks pass at their required test layers. Include trace correlation sufficient to inspect the workflow. Idempotency and fencing are foundational, not postponed hardening.

## Phase 3: failures, recovery, and inspection

Deliverables: classified retries and exhaustion, dead-letter notifications, expected-generation replay, durable quarantine/repair, stale-generation defense, full telemetry, and host-orchestrated failure scenarios.

Exit: remaining HTTP/EVENT cases and DATA-01 through DATA-07 plus DATA-09 through DATA-10, REC-01 through REC-06, OBS-01 through OBS-04, and scenario-related CLI checks pass. Demonstrate crashes after publication, after scheduling, and after an external response before persistence. Preserve and explain possible repeated external calls.

## Phase 4: offline retrieval and evidence

Deliverables: immutable corpus snapshots/versions, lexical-hash profile, tenant-filtered pgvector retrieval, evidence/citation validation, abstention, versioned datasets, and separate retrieval reports.

Exit: relevant AI-01 through AI-04, AI-07, RESULT-01, DATA-08 and security cases pass. Publish measured offline Recall@5 against the labeled corpus and show failures. A provisional target is not reported as an achieved score. Existing jobs retain their pinned corpus/profile across retries.

## Phase 5: bounded agent and optional real adapter

Deliverables: state machine, three read-only tools, budgets, schema validation, simulated tool scenarios, and prompt-injection tests. A real provider is an optional independently reviewed slice, with its own model/embedding profiles and data/cost controls.

Exit: all AI and tool-related SEC cases pass in offline mode. A real-provider feature, if included, requires its own live evaluation evidence; skipping it does not validate it. No arbitrary network/file/shell capabilities or write tools are added.

## Phase 6: reviewer-ready release

Deliverables: complete reproducible scenarios, measured prerequisites, verified quickstart, OpenAPI output, runbooks, migration upgrade proof, trusted release pipeline, selected license/reporting channel, and sanitized evidence links.

Exit: every required acceptance family is mapped to passing evidence at the released revision; Docker-only demo and published artifacts work; there are no undocumented unsupported paths or fake green checks. Hosted deployment remains a separate decision.

## Work and commit discipline

Implement one observable behavior at a time with red-green-refactor. Keep each reviewed implementation commit coherent and green. Architecture approval permits preparation, not automatic commits of non-documentation code: owner review of the exact patch remains required. Documentation commits are autonomous; push/release permission is separate.

Small patch sequence: foundation; create transaction/idempotency; publication; admission; execution/fencing; CLI; failure recovery; retrieval; tools; release evidence. Do not convert the roadmap into one large scaffold or a speculative test suite for unimplemented features.

## Evidence register

Submission and selected security checks have passing local evidence in [review 0012](quality/reviews/0012-authenticated-ticket-http.md). Other acceptance families remain not run unless a focused review records an actual passing subset. Follow [the testing strategy](quality/testing.md); scenario IDs do not imply completion of the full ticket workflow.
