# Automatic simulated executor and end-to-end verification

Status: implemented and locally verified, pending exact-patch approval under the accepted ADR-0001/0002/0003 architecture. Base `354b29c` is committed and pushed. Proposed commit: `feat: run automatic simulated execution with end-to-end verification`.

## Purpose and affected files

A submitted ticket can now finish without a test operator invoking completion. The opt-in executor claims only consumer-admitted PostgreSQL jobs and persists the existing bounded simulated abstention through fenced ownership. The public HTTP result explicitly remains simulated.

- `apps/worker/src/job-executor.ts`: two polling handlers, 500–600 ms idle/backoff interval, serial five-second heartbeats, monotonic 60-second provider deadline, cancellation and classified retry/permanent failure. Ownership loss discards ready or late output; renewal drains before finalization. Uncertain completion acknowledgements never become provider failures or immediate retries. Existing SQL owns lease fencing and the three-attempt budget.
- `apps/worker/src/simulated-provider.ts`: deterministic abstention with no question/corpus reads, tool execution, SDK or network inference.
- `apps/worker/src/executor-main.ts`: separate process, validated worker credential file, restricted worker pool with finite connection/query/statement timeouts, fixed safe log events and bounded shutdown.
- `packages/configuration/src/index.ts`, `tests/configuration.test.cjs`: local-only executor PostgreSQL host/port validation without Kafka configuration.
- `compose.yaml`, `infra/docker/Dockerfile`: optional `execution` profile and non-native executor image target; non-root, read-only, no capabilities/ports/socket, backend network and only the read-only worker secret. Seeded PostgreSQL is the startup dependency. Existing default worker remains idle. The 256 MiB limit is a configured bound, not a measured minimum.
- `tests/job-executor.test.cjs`: deterministic timing, maximum concurrency, classification, cancellation, stale output and ambiguous completion checks through the provider/store interfaces.
- `tests/database/execution-ownership.test.cjs`: authenticated real worker heartbeat, no idle SQL transaction during provider work, shutdown, lease recovery and immutable replacement result after late output.
- `scripts/executor-smoke.mjs`, `package.json`: `npm run test:executor` builds and starts a unique full Compose project from empty volumes, submits via authenticated HTTP, uses real relay/Kafka/consumer and observes an automatically persisted result through HTTP. Test inspection is read-only; it never calls completion or directly schedules work.
- `.github/workflows/foundation.yml`: executor gate after consumer on x64 and ARM64; deadlines increased to 40/30 minutes. No dependencies, lockfile, migrations, grants or native artifact pins change.
- README, documentation map, roadmap, test/CI/Compose notes and review 0019: current implementation status, invocation and evidence boundaries.

## Actual verification on 2026-11-23

Red: the first executor test failed because the implementation module did not exist. Initial timer-controlled tests then exposed that `node:timers/promises` was not driven by the Jest fake clock. The executor now uses an abortable global timer with explicit timer/listener cleanup. This is also verified with an actual five-second heartbeat against PostgreSQL, rather than claiming fake timers establish database-time behavior.

- `npm run check`: formatting, type checking/build and **161 fast tests in 12 suites** passed.
- `npm run test:database`: **147 real PostgreSQL tests in 3 suites** passed on the final test revision. The added test observes actual lease extension, verifies no idle transaction during pending provider work, aborts on shutdown and then recovers the abandoned attempt with a new executor. Expiry is deliberately advanced through the existing controlled fixture using the real SQL expiry predicate; this is not a claim to have waited 30 seconds. The recovered result reports attempt count two and is unchanged when the old provider later resolves.
- `npm run test:executor`: passed on the final script revision. Both opt-in profiles started together from empty test volumes using the advertised full-stack command. Stopping the consumer left the first published ticket queued; resuming it produced the exact simulated result automatically. Three repeated submissions retained the same idempotent receipt/result; foreign and absent tickets returned 404 and all three permitted tenant roles could read. A stopped executor retained a second admitted job and resumed it after restart. A third admitted job completed while Kafka was stopped. Read-only inspection found exactly three tickets, inbox entries, jobs, attempts and results, with completed jobs holding no lease. Non-root/mount/network boundaries, missing-credential failure, safe logs and shutdown within the Compose grace period also passed.
- `npm run test:compose`: the default-profile regression passed with the executor absent: startup, real HTTP submission/read/idempotency/limits, PostgreSQL/Redis stop and pause recovery, credential/data persistence and missing-secret gates.
- `actionlint` 1.7.12 reported no errors. Node syntax, final formatting, relative Markdown links and whitespace checks passed.

Environment: Node 24.22.3; Docker Desktop engine 29.2.1/Linux arm64; Compose 5.1.0; PostgreSQL 17.12/pgvector 0.8.7; Kafka 4.4.0. Docker suites ran sequentially in disposable owned projects. The [baseline hosted workflow](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45106618466) passed for `354b29c`; this new patch has not run in hosted CI or on local x64. Existing native consumer/relay suites were not separately rerun because their implementation and artifact pins did not change; the new end-to-end gate exercises both in the complete workflow.

## Limits and approval boundary

This is deterministic workflow evidence. It does not implement retrieval, supported answers with citations, tools, CLI, replay, real-provider quality, throughput guarantees or release readiness. Two handlers bound active attempts in this process; cancellation of future uncooperative external I/O is not guaranteed. The current provider has no such calls.

The 60-second deadline bounds provider/heartbeat work and is checked monotonically before finalization. SQL finalization has separate finite timeouts and may commit after that instant or return an uncertain acknowledgement. Lost ownership and shutdown take precedence over retry decisions. A 12-second shutdown deadline may force exit if cleanup cannot finish, leaving durable leases to recover; Compose allows 15 seconds. Fencing prevents stale durable writes, not repeated external effects after a crash.

The complete patch, including all new files, requires owner approval before commit: [AGENTS.md](../../../AGENTS.md) states, “Commits containing application code, tests, dependencies, runtime configuration, or other non-documentation changes require the owner's explicit approval of the exact patch before committing.” Push permission is already granted. No commit or push of this patch has been performed.
