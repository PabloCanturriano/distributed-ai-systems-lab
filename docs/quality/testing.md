# Test strategy and acceptance evidence

Status: fast Jest checks, real PostgreSQL integration, application image smoke, and [Compose foundation verification](reviews/0006-compose-foundation.md) are implemented, including [API dependency outage checks](reviews/0007-api-readiness.md). The [native Kafka transport check](reviews/0008-kafka-foundation.md) covers broker persistence and topic startup gates. An isolated [Confluent client evaluation](reviews/0010-kafka-client-compatibility.md) now exercises manual offsets, redelivery, rebalance and broker outage recovery on Linux arm64. [Authenticated submission HTTP checks](reviews/0012-authenticated-ticket-http.md) are committed; [ticket-read checks](reviews/0013-ticket-reads.md) and the outbox protocol are committed. The opt-in real relay has a dedicated `npm run test:relay` integration gate; [review 0015](reviews/0015-local-kafka-relay.md) records its actual results. The complete ticket-processing workflow remains not run. Each review records actual scope and results.

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
