# Kafka foundation review

Status: prepared for exact-patch review; not committed or pushed. Base revision: `55e4b47`. The owner approved the [bounded architecture proposal](../../architecture/kafka-foundation-plan.md) on 2026-11-19. Prior foundation changes, including API dependency readiness, are committed and pushed.

## Purpose and patch

Compose gains a persistent private Kafka broker and explicit, fail-closed topic initialization. A newly starting idle worker waits for topic validation. API startup/readiness retain their PostgreSQL/Redis boundary. No application producer, consumer, or JavaScript client is added.

Proposed commit: `feat: add persistent Kafka foundation and topic initialization`.

Affected files, including new files:

- `compose.yaml`: pinned combined KRaft broker/controller, named data volume, internal listeners, bounded memory/health, topic initializer, worker startup gate.
- `infra/kafka/Dockerfile`, `infra/kafka/admin.properties`, `infra/kafka/init-topics.sh`: same pinned non-root tooling distribution; finite command/connection bounds; fixed topics with exact configuration validation and safe events. Incompatible existing topics are never altered/deleted by initialization.
- `.dockerignore`: explicit Kafka build-input allowlist; private-state exclusions remain last.
- `scripts/kafka-smoke.mjs`, `package.json`: isolated real-broker transport/restart and incompatible-topic checks via `npm run test:kafka`, with project-scoped cleanup. No dependency or lockfile changes.
- `README.md`, `docs/README.md`, `docs/roadmap.md`, `docs/quality/testing.md`, `docs/operations/compose-foundation.md`: current implemented scope, startup dependency and remaining acceptance gates.
- `docs/architecture/kafka-foundation-plan.md`, `docs/operations/kafka-foundation.md`, this review: approved scope, operational boundaries, results and limitations.

The complete review patch includes tracked and untracked files. Existing ignored IDE settings remain untouched. Exact-patch commit approval and push authorization are separate.

## Distribution and environment

Apache Kafka 4.4.0 JVM image: `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f`. The [Apache release list](https://kafka.apache.org/downloads/) identifies the release. Its public index advertises Linux amd64 and arm64; execution here is Linux arm64 only, on macOS arm64 with Node 24.22.3, Docker engine 29.2.1 and Compose v5.1.0.

The vendor [Dockerfile](https://github.com/apache/kafka/blob/4.4.0/docker/jvm/Dockerfile) supplies `appuser` and the data-directory ownership. The vendor [configure script](https://github.com/apache/kafka/blob/4.4.0/docker/resources/common-scripts/configure) requires writable generated configuration; broker root filesystem is intentionally writable. Broker and initializer have no published ports, no added capabilities, and no database/demo credential mounts. Initializer root filesystem is read-only with temporary Java paths; inherited vendor anonymous volumes are not claimed absent.

## Verification on 2026-11-19

`npm run test:kafka` passed against the actual pinned broker, including final project cleanup:

- CLI reports version 4.4.0; actual broker/job identities are `appuser`; broker has no host port bindings and uses named persistent data. Initializer is read-only and mounts no `/run/lab` secrets.
- Both fixed topics initialize with three partitions, replication/minimum ISR 1, exact delete-only cleanup and seven-day retention. Repeating initialization succeeds.
- A fictional keyed record is synchronously acknowledged with `acks=all` on a separate one-partition probe topic, then consumed at explicit partition/offset with automatic commits disabled.
- That record survives broker stop/start and container recreation retaining named volumes. API readiness remains 200 while Kafka is stopped.
- Deliberate `delete,compact` drift fails initialization; the test alone restores its mutation before continuing. Deliberately increasing scheduling partitions to four also fails initialization. Recreating containers preserves that incompatible setting, blocks a newly starting worker, and preserves the probe record.
- Unknown-topic publication fails within the bounded command; the topic is not automatically created. Default captured broker/job logs contain no probe payload.

The first run reached message delivery but failed an exact output assertion because Kafka 4.4 printed deprecation notices for old console options. The corrected test uses `--command-property`, `--reader-property` and `--formatter-property`. Exact whole-value topic configuration checks additionally reject combined `delete,compact`, rather than accepting a matching `delete` prefix. The final test passed these cases.

Final warm-cache build/start observation: 17577 ms. A single broker sample was 334.6 MiB / 1 GiB and 2.21% CPU. An earlier initial pull/build/start took 63223 ms with a 345.7 MiB broker sample. These observations use a disposable small test workload and are not benchmarks or minimum hardware claims.

Regression checks passed:

- `npm run check`: formatting, workspace type checks/builds and 52 fast tests in five suites. An initial restricted invocation could not open loopback listeners (`EPERM`); the permitted rerun passed.
- `npm run test:database`: 28 real PostgreSQL tests, including permissions, migrations, identities and recovery checks.
- `npm run test:containers`: API and worker image builds, startup, isolation, safe configuration rejection and shutdown.
- `npm run test:compose`: complete initialization with the new Kafka startup gate, safe health and scoped mounts; PostgreSQL/Redis stop/start and pause/resume recovery without an API restart; bounded shutdown; repeated startup/container recreation preserving credentials and rows; missing identity/password rejection without regeneration or secret logs.
- `bash -n infra/kafka/init-topics.sh`, `node --check scripts/kafka-smoke.mjs`, final formatting, changed Markdown relative links and whitespace checks passed.

All disposable test projects completed their scoped cleanup. No developer installation was reset. Regression commands do not add proof of unimplemented ticket behavior.

## Dependency and security findings

The 2026-11-19 npm audit reports **24 moderate affected package entries**, with glob/minimatch tooling advisories. The scoped API/worker production audit reports **0 findings**. These are affected package counts, not distinct advisories. The previous review's historical audit counts are left unchanged. No dependency update, downgrade, override, or suppression is introduced by this patch. Initializer-image operational dependencies and OS images have not been scanned and are not declared security-clean.

No KafkaJS package is installed. Its maintenance suitability and compatibility with this broker remain an explicit gate before application producer/consumer work; bundled Java tools do not satisfy it.

## Remaining scope

These checks provide partial local startup, persistence, isolation and safe-log evidence. They do not establish EVENT acceptance scenarios, outbox/inbox atomicity, committed offsets after database admission, deduplication, event validation/quarantine, job recovery, worker readiness, telemetry, high availability, disk-failure survival, throughput, or complete phase-1 acceptance. One broker/controller with replication 1 and plaintext internal traffic is trusted local infrastructure only. Seven-day retention does not guarantee indefinite recovery or business-state durability.
