# Test strategy and acceptance evidence

Status: fast Jest checks, real PostgreSQL integration, application image smoke, and [Compose foundation verification](reviews/0006-compose-foundation.md) are implemented, including [API dependency outage checks](reviews/0007-api-readiness.md). The [native Kafka transport check](reviews/0008-kafka-foundation.md) covers broker persistence and topic startup gates. An isolated [Confluent client evaluation](reviews/0010-kafka-client-compatibility.md) now exercises manual offsets, redelivery, rebalance and broker outage recovery on Linux arm64. [Authenticated submission HTTP checks](reviews/0012-authenticated-ticket-http.md) are committed; [ticket-read checks](reviews/0013-ticket-reads.md) and the outbox protocol are committed. The opt-in real relay has a dedicated `npm run test:relay` integration gate; [review 0015](reviews/0015-local-kafka-relay.md) records its actual results. The [automatic executor gate](reviews/0020-automatic-executor.md), `npm run test:executor`, passed the complete authenticated HTTP → real Kafka → consumer → executor → persisted simulated result → HTTP journey. This adds deterministic execution evidence, not retrieval or real-model quality evidence. The [CLI gate](reviews/0021-ticket-cli.md), `npm run test:cli`, checks the containerized HTTP client against that workflow, with separate real HTTP transport tests. The committed [replay batch](reviews/0022-ticket-replay-batch.md) adds real SQL concurrency/rollback/history evidence and `npm run test:replay` for the complete operator recovery journey through Kafka. The [phase-2 gate](phase2.md), `npm run test:phase2`, executes every required layer and checks the [acceptance manifest](phase2-acceptance.json). Its trace journey verifies real HTTP concurrency/lost-body retry and the Kafka/worker parent chain. Each review records actual scope and results.

## Development loop

For each behavior, select one acceptance ID, write the smallest meaningful failing test, confirm the intended failure, implement, and refactor. Keep the red step local; commits contain the behavior and its passing tests together. Infrastructure bootstrap is verified through build/startup checks rather than artificial business tests.

Use Jest as the proposed runner and Testcontainers for disposable real dependencies. [Testcontainers for Node.js](https://node.testcontainers.org/quickstart/install/) requires a compatible container runtime; CI must provision that explicitly. Run tests from the trusted host/CI environment, not by mounting a Docker socket inside application containers.

## Layers

| Layer | Tests | Avoid |
| --- | --- | --- |
| Unit | Lifecycle transitions, budgets, canonical input, error classification | Mocking every internal call or testing private methods |
| Contract | HTTP/event/tool schemas, version compatibility, CLI JSON/error behavior | Duplicating schema implementations in tests |
| PostgreSQL integration | Atomicity, uniqueness, leases, fencing, tenant FKs, upgrade paths | Mock SQL calls as proof of transactional correctness |
| Kafka integration | Manual offset handoff, redelivery, quarantine, partition sequencing | Calling a handler directly as proof of broker recovery |
| End-to-end | CLI/API to durable simulated result | Replacing the event path with direct database scheduling |
| Evaluation | Retrieval ranking, citations, abstention, expected tool behavior | Treating scripted output as real-model quality |
| Security | Tenant isolation, role denial, injection, safe logs and credentials | Relying on prompts as authorization |

## Reliable concurrency and failure tests

Coordinate interleavings with barriers/checkpoints, then assert durable state. Do not rely on arbitrary sleeps to win a race. Use bounded polling for broker delivery or lease expiry and include diagnostic state on timeout. Unit timers may be fake; ownership integration tests use the same database-time predicates as runtime.

Failure checkpoints are explicit, opt-in local test seams: after transaction commit, after broker acknowledgement, before offset commit, and after external response before result persistence. They are not public API routes, arbitrary commands, or AI tools. Never include production secrets in test fixtures.

Tests isolate databases/schemas, broker topics/groups, and tenants by run ID. Dispose of only resources owned by that run. Do not reset a developer's demo stack as test cleanup. Preserve sanitized evidence for a failing case, then clean up through bounded hooks.

A flaky failure is investigated; rerunning until green does not establish correctness. Quarantine an unreliable test only with a tracked issue, owner, reason, and expiry. Required guarantees cannot be declared complete while their only evidence is quarantined.

## Traceability

| Scenario family | Source | Required evidence |
| --- | --- | --- |
| HTTP-01 through HTTP-08 | [Contracts](../architecture/contracts.md) | Real API/database assertions, including concurrent keys and replay |
| EVENT-01 through EVENT-06 | [Contracts](../architecture/contracts.md) | Real broker/database handoff and durable quarantine |
| RESULT-01 through RESULT-02 | [Contracts](../architecture/contracts.md) | Schema, safe output, and simulated execution checks |
| DATA-01 through DATA-10 | [Data model](../architecture/data-model.md) | Real PostgreSQL rollback, locks, fencing, and history checks |
| SEC-01 through SEC-14 | [Security](../architecture/security.md) | Negative authorization tests plus Compose/privilege inspection |
| AI-01 through AI-08 | [AI design](../architecture/ai-system.md) | Deterministic retrieval/tool tests and separately labeled reports |
| CLI-01 through CLI-06 | [CLI contract](../architecture/cli.md) | Containerized client output, exit codes, deadlines, and identities |
| OPS-01 through OPS-06 | [Local operation](../operations/local-environment.md) | Clean boot, restart, readiness, and reset evidence |
| REC-01 through REC-06 | [Recovery](../operations/recovery.md) | Host/checkpoint recovery, idempotent delivery repair, and expected-state guards |
| OBS-01 through OBS-04 | [Observability](../operations/observability.md) | Trace links, safe metadata, metric presence, and outage behavior |

The implementation maps each automated test/report to these IDs. A scenario may need several tests; a passing unit test cannot stand in for its required integration proof. New defects add regression cases rather than silently redefining the original expectation.

## Reports and gates

A report records revision, environment/image versions, run ID, scenarios selected, actual assertions, durations, and failures. Unavailable prerequisites produce not-run/failure, never pass. Red-to-green review evidence should name the initial missing behavior and final command/results; do not fabricate execution logs.

The initial required CI gate includes formatting, lint, type checking, unit/contract tests, PostgreSQL and Kafka integration, migration checks, simulated end-to-end smoke, and deterministic security/evaluation assertions. Expensive recovery suites may run as a separate required trusted branch/release job, provided no release bypasses them.

Coverage is diagnostic, not the primary target. Required scenarios must be accounted for individually. Introduce a numeric coverage gate only after a useful baseline exists; do not inflate coverage with tests that mirror getters or generated code.

Real-provider runs are opt-in trusted jobs with finite budgets and no secrets on forked pull requests. Missing provider credentials do not invalidate the offline release, but a real-provider feature cannot claim validation from a skipped run. Publish corpus/profile-specific scores and limitations as described in the AI design.

## Performance evidence

Before setting throughput or hardware claims, measure cold and warm startup, end-to-end ticket latency, outbox/job queue age, and resource use under a declared workload. Report concurrency, input size, cache state, failure rate, and environment. Regressions require a repeatable baseline; no current performance SLO exists.


## Phase-3 combined acceptance

The [phase-3 gate](phase3.md), `npm run test:phase3`, retains all existing layers and requires audited delivery repair, observed response-before-persistence recovery and actual Collector/Jaeger/Prometheus inspection. Its [manifest](phase3-acceptance.json) covers 42 unique criteria; final verification status is recorded with the implementation digest. New tests exercise same/different-key repair and admission races behind observed PostgreSQL locks, rollback/lost acknowledgement, role denial, both late-event orders, project/environment/hash guards and credential upgrade/missing-file behavior.

The host runner refuses success without both its required observed checkpoint and a successful full harness. The business CLI refuses host scenarios without making API calls. No actor code is included in application images. Real lease-expiry tests retain the production 30-second rule, while exporter queue/deadline tests use a deterministic fake clock. The simulated provider test observes repeated responses without claiming third-party side-effect idempotency.


## Phase-4 evidence

`npm run test:phase4` requires all previous layers plus `evaluate:retrieval` and `test:rag`, covering 52 explicitly scoped criteria. The standalone ranking report and full acceptance report share the exact source/fixture digest. Pure tests cover hashing, Unicode chunking, UUIDv8 identity and structural evidence validation; SQL tests cover immutable manifests, context pinning, real pgvector scope, cache separation, citation provenance/retention and rollback. The RAG gate uses authenticated CLI/HTTP and actual Kafka/executor processing. Agent tools and real-generation semantics do not gain coverage merely because lexical retrieval passes. See [phase-4 record](phase4.md).

## Phase-5 offline library slice

The [bounded-agent review](reviews/0026-bounded-offline-agent.md) adds strict model/tool contracts, serial budgets, fake-clock deadlines and real worker-role lifecycle reads. `npm run evaluate:workflow` runs twelve versioned scripted cases and writes `artifacts/agent-workflow-v1-report.json`, explicitly labeled `workflow` / `offline-scripted` / `deterministic-fixtures`. It reports expected safe rejections and actual executed tool names separately from forbidden requests. It does not query pgvector or establish semantic quality. The SQL integration suite separately executes the library against actual pgvector retrieval and scoped PostgreSQL lifecycle reads, including credential revocation. The activated agent now adds atomic evidence/result/summary persistence and end-to-end CLI/Kafka verification. The response-crash actor executes the real offline provider, pauses with nonempty evidence before completion, is killed, waits for the real lease, and verifies retry completion with no writes from the abandoned attempt.

`npm run test:phase5` retains all sixteen phase-four gates and adds `evaluate:workflow`. Its manifest maps 59 criteria, including AI-05/06/08 and tool-related SEC-06/07/08/09. It requires unchanged implementation/fixture sources and matching source identities in both retrieval and workflow reports. Hosted CI adds the workflow evaluation on x64 and ARM64; local completion is not hosted phase-five success or a release.
