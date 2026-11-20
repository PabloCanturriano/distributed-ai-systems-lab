# Kafka client selection review

Status: documentation review completed on 2026-11-19; client selection remains open for owner review. No client was installed or executed. This follows the committed broker foundation (`f679c74`), whose Java tooling does not establish JavaScript compatibility.

## Findings

The accepted [ADR-0002](../../adr/0002-typescript-workspaces-and-adapters.md) selects KafkaJS subject to compatibility and maintenance review before pinning. Current npm metadata and the [upstream release list](https://github.com/tulios/kafkajs/releases) report KafkaJS 2.2.4, published 2023-02-27. The [tagged manifest](https://github.com/tulios/kafkajs/blob/v2.2.4/package.json) declares Node >=14 and no runtime dependencies. Those are useful packaging properties; an engine range alone does not prove Node 24 or Kafka 4.4 support.

KafkaJS documents [manual offset commits and sequential per-partition handling](https://kafka.js.org/docs/consuming). It therefore offers the required conceptual controls. However, the absence of a newer published stable release leaves maintenance confidence insufficient for an automatic selection in this lab. This is a project risk assessment, not a finding that the project is abandoned or that the client cannot work.

[Issue #1752](https://github.com/tulios/kafkajs/issues/1752) reports group coordination failure with KafkaJS 2.2.4/Kafka 4.0.0 and is closed. Its report uses a different runtime and broker version. It is a reason to test group admission explicitly, not proof of a defect in our 4.4.0 setup or grounds to declare incompatibility. No failing KafkaJS compatibility result is claimed.

The alternative `@confluentinc/kafka-javascript` currently publishes version 1.11.0 (npm timestamp 2026-10-07), engine Node >=18, MIT package license. Its [tagged manifest](https://github.com/confluentinc/confluent-kafka-javascript/blob/v1.11.0/package.json) identifies librdkafka 2.16.0 and a native installation hook downloading a release binary or falling back to a build. Recent publication and vendor ownership are positive maintenance signals, not evidence of security or correctness in our environment.

The [tagged README](https://github.com/confluentinc/confluent-kafka-javascript/blob/v1.11.0/README.md) lists Node 24 for Debian Bookworm on Linux x64/arm64 and macOS arm64. The general [installation documentation](https://docs.confluent.io/kafka-clients/javascript/current/overview.html) still lists older Node versions. Treat this discrepancy as a verification requirement: actual binary loading in the pinned runtime must pass before adoption.

## Packaging and behavior risks

Our existing application Dockerfile deliberately uses `npm ci --ignore-scripts` in all dependency stages. Adding a native package alone will not perform its required installation. A candidate implementation must preserve disabled general lifecycle scripts, explicitly prepare only the reviewed native package in a build stage, and record the downloaded artifact identity/checksum or a reproducible reviewed source-build path. Do not silently enable scripts across the dependency graph or install compilers in runtime images.

The [migration guide](https://github.com/confluentinc/confluent-kafka-javascript/blob/v1.11.0/MIGRATION.md) describes API differences, including acknowledgement configuration on the producer and automatic-commit configuration on the consumer. Similar method names are not a drop-in semantic guarantee. Prefer the vendor's documented promisified API and native configuration keys behind our own adapter.

The [offset documentation](https://github.com/confluentinc/confluent-kafka-javascript/blob/v1.11.0/INTRODUCTION.md#committing-offsets) supports disabling automatic commits and explicitly committing the next offset. Rebalance/disconnect behavior must be tested, especially while admission is incomplete. Use decimal-string/BigInt-safe arithmetic rather than lossy JavaScript number conversion for offsets.

## Recommendation and next slice

Reopen the client choice and review [proposed ADR-0005](../../adr/0005-kafka-client-compatibility-gate.md): evaluate Confluent's client in a bounded compatibility slice before application wiring. Retaining KafkaJS remains a legitimate alternative if the owner accepts its maintenance uncertainty and authorizes a comparable compatibility investigation. Do not downgrade the broker or bypass Kafka with direct scheduling to avoid the decision.

The proposed slice verifies the actual pinned Node/Linux environment, delivery acknowledgement, consumer-group admission, manual committed-offset boundaries, redelivery, rebalance and shutdown using fictional records in a disposable installation. It does not implement ticket admission, schemas, outbox/inbox tables, AI execution, hosted deployment or telemetry.

## Evidence and limitations

Read-only queries performed:

- `npm view kafkajs version time engines dependencies --json`.
- `npm view @confluentinc/kafka-javascript version time engines license --json`.
- Upstream tagged manifests, release lists, requirements, migration and offset documentation linked above.
- Local inspection of `infra/docker/Dockerfile`, accepted ADR-0002 and the broker review boundaries.

Metadata was retrieved successfully. Both candidate versions above were current in those responses on 2026-11-19. Package metadata sources: [KafkaJS registry document](https://registry.npmjs.org/kafkajs), [Confluent registry document](https://registry.npmjs.org/@confluentinc%2fkafka-javascript).

Documentation validation covers relative links and whitespace. No new dependency audit, native artifact/security/license inventory, image scan, client build, broker/client integration, performance test or business acceptance scenario ran in this slice. Existing tests from review 0008 remain historical broker/foundation evidence; they are not relabeled as client results.
