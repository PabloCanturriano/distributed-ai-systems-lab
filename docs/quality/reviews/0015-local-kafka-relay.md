# Real local Kafka outbox relay

Status: exact implementation patch approved by the owner and committed as `4723309`; not pushed. Base `587f3bb` contains the approved SQL publication protocol. Proposed commit: `feat: publish outbox events through an opt-in Kafka relay`.

## Purpose and affected files

- `apps/worker/src/kafka-publisher.ts`: Confluent adapter behind `OutboxPublisher`. Publication resolves after delivery acknowledgement, with all-replica acknowledgements and automatic topic creation disabled. Key and value are the ticket ID and exact stored payload. Failed/aborted producers retire before replacement, and late acceptance never reports successful publication after cancellation. SDK errors and payloads are not logged.
- `apps/worker/src/relay-main.ts`: separate local process, one leased event per batch, 500–600 ms polling jitter, bounded PostgreSQL pool and I/O, restricted relay login/role, strict private credential file checks and fixed log events. Signals stop claims and interrupt sending; a 12-second shutdown deadline leaves uncertain work recoverable within Compose's 15-second policy. The default worker stays idle.
- `apps/worker/package.json`, `package-lock.json`: exact application SDK 1.11.0; lifecycle hooks remain disabled. `packages/configuration/src/index.ts` adds separately validated relay endpoints without changing API/idle-worker defaults.
- `infra/docker/prepare-kafka-native.mjs`, `infra/docker/Dockerfile`, `.dockerignore`: relay-only native preparation, fixed official checksums and ABI/platform/version guards, extraction of only the addon, no compiler/source fallback. API and idle-worker build paths do not download native artifacts. Runtime retains upstream package/native notices.
- `compose.yaml`: opt-in `messaging` profile, non-root/read-only/capability-free relay, backend network only, no host ports, only its read-only relay-password volume, seed/topic startup gates and a 256 MiB local container limit. This is a chosen bound, not a measured minimum.
- `tests/kafka-publisher.test.cjs`, `tests/configuration.test.cjs`: acknowledged/uncertain delivery, cancellation and safe configuration cases. `scripts/relay-smoke.mjs`, `package.json` and `.github/workflows/foundation.yml`: real HTTP/database/broker failure gate on both CI architecture jobs. Checkpoints exist only in injected trusted test code, not production environment flags or public routes.
- README/map/roadmap, ADR-0006, operation/testing/CI notes and review 0014 update the current boundary and document startup/review evidence.

## Actual verification on 2026-11-20

Red: the relay configuration acceptance checks first failed because `loadRelayConfiguration` was absent (5 failed, 41 existing checks passed). After implementation:

- `npm run check`: formatting, type checks/builds and **89 fast tests in 8 suites** passed. Five adapter tests cover delivery acknowledgement, abort before/after connection, retirement before replacement and closed/pre-aborted publication; relay configuration adds five cases. HTTP tests require local loopback binding, so this run used the authorized host environment after the filesystem sandbox rejected those socket operations.
- `RELAY_TEST_PLATFORM=linux/amd64 npm run test:relay` passed with the real application adapter on **Linux arm64** and **Linux amd64 under Docker Desktop emulation**. Both loaded librdkafka **2.16.0**. The alternate-platform adapter also delivered an authenticated HTTP-created event, independently read back by Kafka's JVM consumer with the exact stored key/value. This is not physical amd64 hardware or hosted runner evidence.
- Real HTTP submission -> PostgreSQL outbox -> running relay -> Kafka -> fenced SQL acknowledgement passed. Independent Kafka tooling checked exact bytes and stable event ID; the ticket execution remained queued.
- Stopping Kafka retained unpublished retryable work and kept HTTP submissions available. SIGTERM during a subsequent active publication exited successfully within 15 seconds; restarting the relay and broker delivered the event with increased attempts.
- The test-only driver exited abruptly with code 75 immediately after a real broker acknowledgement, before SQL marking or cleanup. The row remained claimed/unpublished; after the real 30-second database lease expired, the relay delivered the identical event again. Independent broker reads saw two copies with the same ticket key, event ID and payload. No lease timestamp was edited to shortcut recovery.
- Missing relay credentials fail with only fixed startup/stopped events. Container inspection verified non-root/read-only execution, dropped capabilities, no host ports and only the read-only relay-password mount. Captured logs were checked inside trusted initialization jobs against known credentials, without exporting credential values.
- `actionlint` **1.7.12** reported no errors for the changed workflow. Full/runtime npm audit results are recorded below.

The first smoke iterations exposed two inspection-query mistakes and Linux PID 1 ignoring a self-sent SIGKILL. The test now queries execution status using the actual composite relationship and uses explicit abrupt exit at the acknowledgement checkpoint; the corrected full broker/database run passed. No production fault-injection hook was added.

`npm run test:containers` and `npm run test:compose` passed: default API/idle-worker isolation/startup/shutdown, real authenticated HTTP/read/idempotency/rate limits, dependency stop/pause recovery, persistent credentials/rows and missing-secret startup gates. A final `npm run test:relay` also passed with both stdout/stderr log checks and scoped image/container/volume cleanup. Formatting, relative Markdown links in changed documents, workflow lint and whitespace checks passed. Environment: macOS arm64 host, Node **24.22.3**, Docker Desktop engine **29.2.1**, PostgreSQL **17.12**/pgvector **0.8.7**, Kafka **4.4.0**. The unchanged SQL protocol's **94 PostgreSQL tests** passed for base `587f3bb`; they were not rerun for this adapter-only slice.

## Native provenance and security boundary

Registry metadata was rechecked: SDK 1.11.0, Node >=18, package integrity `sha512-DKv7bvUiT60UlBEBNYq54v8kKaRlN/zMhZFTtkjm/qXDxiUSkiEP1JQRncr2I9QEa9Tq51kuDTyVnR4ZQFzmMw==`. Installation used `--ignore-scripts`.

Official release artifact checksums for Node ABI 137, Linux glibc:

| Architecture              | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| arm64                     | `8ce2595cfe62bae5fafd206ed78d1d8a8188e2019534b063f51710a8e7798384` |
| amd64 (artifact name x64) | `56b443c9339cb0ae423588599af1df7636eb426c1ac93bf54906e52a0ee77699` |

Sources: [official 1.11.0 release](https://github.com/confluentinc/confluent-kafka-javascript/releases/tag/v1.11.0), [promisified API introduction](https://github.com/confluentinc/confluent-kafka-javascript/blob/v1.11.0/INTRODUCTION.md), and the pinned SDK's bundled types/source. The adapter uses native producer settings; KafkaJS-compatible configuration is supplied only through its supported configuration objects.

`npm audit` reports 0 API/worker production findings and 24 moderate affected tool-graph entries in the full installation. This audit does not inventory or scan statically bundled native libraries or the OS image. Native/OS SBOM, vulnerability scanning, hosted CI execution, production TLS/ACL and release eligibility remain open gates. No security-clean or production-ready claim is made.

## Delivery boundary

Successful publication does not advance ticket state. This patch supplies no consumer/inbox, executor, results, replay or AI behavior. Delivery is at least once: a broker acceptance followed by a process/SQL acknowledgement failure can repeat the same event. Database lease tokens fence marking, not broker acceptance. Future consumers must deduplicate stable event IDs. API readiness retains its PostgreSQL/Redis dependency boundary.

The exact complete patch, including new files, must be approved under [AGENTS.md](../../../AGENTS.md) before its non-documentation commit. That approval does not authorize push or release.
