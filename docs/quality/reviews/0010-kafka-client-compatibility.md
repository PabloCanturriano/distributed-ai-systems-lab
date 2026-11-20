# Confluent Kafka client compatibility evaluation

Status: experimental implementation prepared for exact-patch review; not committed or pushed. The preceding documentation-only preflight commit remains local. The owner explicitly approved the bounded [ADR-0005](../../adr/0005-kafka-client-compatibility-gate.md) evaluation on 2026-11-19. Base revision: `fb0c46d` (artifact preflight documentation); broker foundation is `f679c74`. This result does not adopt an SDK in API/worker.

## Purpose and affected files

The broker's Java-tool test could not establish JavaScript client compatibility. This patch adds a separate, reproducible native-client experiment without extending the application's dependency graph or changing service startup.

Proposed commit: `test: evaluate Confluent Kafka client compatibility`.

- `experiments/kafka-client/package.json`, `package-lock.json`: test-only client 1.11.0 and 26 locked package entries, outside root npm workspaces.
- `experiments/kafka-client/prepare-native.mjs`, `Dockerfile`, `.dockerignore`: explicit artifact identity/platform/integrity gates, npm lifecycle scripts disabled, isolated allowlisted build context and non-root runtime.
- `experiments/kafka-client/probe.mjs`: native environment checks, delivery reports, broker offset inspection through a separate administrative connection, child-process failure/rebalance scenarios and safe status output.
- `experiments/kafka-client/consumer.mjs`: disposable group member validating fictional records and waiting on IPC release/commit checkpoints. BigInt increments decimal offsets; no SDK types or handlers are imported by applications.
- `scripts/kafka-client-smoke.mjs`, root `package.json`: `test:kafka-client`, isolated image/broker orchestration, outage coordination, runtime/log assertions and scoped cleanup.
- Experimental `README.md`, root `README.md`, `docs/README.md`, `docs/roadmap.md`, `docs/quality/testing.md`, ADRs 0002/0005, follow-up note in review 0009 and this report: approval status, operation, evidence and remaining adoption boundaries.

Full review must include all new files and the separate lockfile. Root application lockfile, dependencies, Dockerfile and Compose configuration are unchanged. No implementation commit or push is authorized by architecture approval alone.

## Versions and artifact identity

Execution on 2026-11-19: macOS arm64 host, Docker engine 29.2.1, Linux arm64 containers. The pinned runtime is Node 24.22.3 Bookworm slim, digest `sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`. The native probe asserts Node version, ABI 137, Linux/arm64, UID 1000 and actual librdkafka 2.16.0. Broker remains the pinned Apache Kafka 4.4.0 from review 0008.

Package: `@confluentinc/kafka-javascript` 1.11.0, still current in the npm metadata recheck before lock resolution. npm integrity is recorded in the experimental lockfile. The [tagged package manifest](https://github.com/confluentinc/confluent-kafka-javascript/blob/v1.11.0/package.json) identifies the native distribution and installation mechanism.

Official [release asset](https://github.com/confluentinc/confluent-kafka-javascript/releases/tag/v1.11.0): `confluent-kafka-javascript-v1.11.0-node-v137-linux-glibc-arm64.tar.gz`. Archive SHA-256: `8ce2595cfe62bae5fafd206ed78d1d8a8188e2019534b063f51710a8e7798384`, verified against the publisher's release API digest and checked by the build before extraction. Only `Release/confluent-kafka-javascript.node` is extracted; vendor object/build metadata is excluded. A same-publisher digest verifies identity/integrity, not an independent signature.

All npm installation hooks remain disabled. Native preparation performs a fixed HTTPS fetch, checksum verification and extraction; it does not invoke node-pre-gyp, a compiler, a source-build fallback or arbitrary lifecycle scripts. The runtime retains the package's source/license notices and transitive installation-helper packages; this is an experiment, not a minimized application image.

## Actual results

`npm run test:kafka-client` completed successfully, including test-project cleanup:

1. The native addon loads in the pinned image as UID 1000 and reports librdkafka 2.16.0. The probe container is read-only, drops ALL capabilities, mounts nothing and has the specified memory limit.
2. Publishing two keyed records to the same explicit partition returns acknowledgement metadata with expected partition and offsets 0/1. Consumer validates key, payload and an injected fictional secret header without logging them. Only one callback is dispatched while that partition's first callback is blocked.
3. The broker's committed offset stays unset through repeated independent admin queries over a 6.5-second window, longer than the SDK's documented default automatic commit interval. Consumer is then killed with SIGKILL. The same group redelivers offset 0.
4. Explicit commit of next offset 1 is visible through the administrative connection. Offset 1 is then delivered and left uncommitted. Normal disconnect releases that transport callback without explicit commit, and the broker remains at 1. A new process redelivers offset 1; explicit next-offset commit advances to 2.
5. A consumer owns both partitions of a separate topic and blocks on partition 1. A second member joins; broker group state confirms a rebalance while the callback remains blocked. Offset is still unset. Releasing without committing allows revocation and one-partition assignments; offset 0 is redelivered after rebalance. Closing both members leaves it uncommitted. This exercises eager range assignment only.
6. Unknown-topic publication fails in 5062 ms and metadata confirms the topic was not auto-created. With the broker stopped by the host, publication fails in 5174 ms. After broker health returns, the same producer and consumer recover, deliver and explicitly commit a new record; observed post-health recovery was 1810 ms. These are local observations, not an SLO.
7. Captured probe/child/broker logs contain no fixture key, payload prefix or fictional secret marker. Native SDK logging is configured at level 0; this is not proof of safety for debug logging or arbitrary application errors.

The first integration run passed manual-offset scenarios but failed in the rebalance harness: the SDK represents group state as a numeric enum, while the test compared a textual label. The corrected harness uses the exported `ConsumerGroupStates.PREPARING_REBALANCE` constant. The final run then passed the same blocked-rebalance assertions; this was a test interpretation error, not an observed SDK compatibility defect.

Regression/check results: `npm run check` passed formatting, workspace type checks/builds and 52 tests in five suites. `npm run test:containers` also passed API/worker builds, startup, isolation, safe rejection and shutdown. Final formatting, JavaScript syntax, relative documentation links and whitespace checks passed. A networkless read-only run additionally confirmed the standard GCC/G++/make/Python/PostgreSQL/Kafka tool paths are absent from the same experimental runtime. PostgreSQL and full Compose failure suites are not rerun for this patch: no database, application dependency, service configuration or business behavior changed.

## Dependency and license inspection

`npm audit --prefix experiments/kafka-client --json` reported **0 findings** for the separate lockfile. This does not cover the root development-tool graph or native/OS libraries.

Installed package manifests were inspected for all 26 locked entries. Reported identifiers include MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Python-2.0 and BlueOak-1.0.0. The published package retains KafkaJS/node-rdkafka notices, librdkafka's two-clause redistribution terms and component notices in `deps/librdkafka/LICENSES.txt`. These notices are retained when dependencies are copied into the experimental image. This inventory does not select the repository's own distribution license or constitute a comprehensive release/license clearance.

`ldd` on the addon resolves only the system C/C++ runtime and math/thread libraries (libstdc++, libm, libgcc_s, libpthread, libc and the loader). No missing shared library was observed. That output does not enumerate statically linked components. Native binary SBOM/vulnerability scanning and OS-image scanning were not performed; no security-clean native-image claim is made. Production adoption must retain this limitation for review rather than infer coverage from npm audit.

## Interpretation and remaining scope

Packaging and the tested transport/manual-offset behaviors passed on Linux arm64 only. No Linux amd64 execution, macOS-native load, hosted cluster, authentication/TLS, cooperative assignment, sustained load or resource benchmark is established.

The protocol checkpoints represent unfinished/completed transport handlers, not a committed SQL inbox/job transaction. These checks do not prove EVENT acceptance, durable admission, duplicate suppression, schema validation/quarantine, outbox publication, stale-generation handling, exactly-once effects or external-call recovery. A handler's native offset must never be committed merely because it began processing or lost its partition.

Application SDK adoption remains a separate review decision. Before business messaging, approve the selected adapter and its exact patch, integrate commit-after-durable-admission with PostgreSQL tests, retain bounded recovery/shutdown and safe-log controls, and address the native security/inventory limitations appropriate to the target release. Do not convert this experiment into an always-running worker or bypass the required transaction design.
