# Documentation map

The repository is in phase 1. Runtime, local startup configuration, and application images are implemented. Database foundation and persistent fictional identities are committed; the Compose foundation is committed and [API dependency readiness](quality/reviews/0007-api-readiness.md) is committed; the [Kafka foundation](quality/reviews/0008-kafka-foundation.md) is committed; the approved [client compatibility evaluation](quality/reviews/0010-kafka-client-compatibility.md) is prepared for exact-patch review; ticket-processing behavior remains proposed. The owner accepted the architecture baseline on 2026-11-16; phase 1 preparation is authorized. This is not an application release.

## Read in this order

1. [Architecture overview](architecture/overview.md): components, handoff, lifecycle, and guarantees.
2. [HTTP and event contracts](architecture/contracts.md): observable behavior, errors, idempotency, and replay.
3. [Data model](architecture/data-model.md): integrity constraints and transaction boundaries.
4. [Security and local identity](architecture/security.md): permissions, trust boundaries, and threats.
5. [AI and retrieval](architecture/ai-system.md): corpus, offline limitations, tool contracts, and evaluations.
6. [CLI journey](architecture/cli.md): intended reviewer experience and scenario boundaries.
7. [Architecture review checklist](architecture/review.md): proposed decisions and implementation gate.

## Implementation preparation

- [Kafka client compatibility](quality/reviews/0010-kafka-client-compatibility.md): isolated native packaging, manual-offset/redelivery/rebalance evidence, and remaining adoption limits.

- [Kafka client selection](quality/reviews/0009-kafka-client-selection.md): maintenance findings, native packaging implications and a proposed compatibility gate.

- [Kafka foundation review](quality/reviews/0008-kafka-foundation.md): persistent broker, explicit topics, native transport/restart checks, and remaining application-client gate.

- [API readiness review](quality/reviews/0007-api-readiness.md): PostgreSQL/Redis checks, bounded outage recovery, scoped credentials, and current audit findings.

- [Compose foundation review](quality/reviews/0006-compose-foundation.md): Docker-only initialization, restricted logins, persistent volumes, and failure gates.

- [Local identity review](quality/reviews/0005-local-identities.md): durable private credentials, immutable fixture checks, concurrency, and recovery evidence.

- [Database foundation review](quality/reviews/0004-database-foundation.md): role/schema bootstrap, identity migration, integration checks, and unresolved tool findings.

- [Container packaging review](quality/reviews/0003-container-images.md): separate runtime images, lifecycle checks, and limitations.

- [Startup configuration review](quality/reviews/0002-startup-configuration.md): shared validation, safe startup failures, and local test evidence.

- [Roadmap](roadmap.md): phased deliverables and acceptance gates.
- [Repository conventions](architecture/repository.md): layout, module boundaries, migrations, and review.
- [Runtime limits](architecture/runtime-limits.md): proposed finite budgets and timing values.
- [Test strategy](quality/testing.md): TDD, real integration evidence, and scenario traceability.
- [CI and release](quality/ci-release.md): required gates, trusted publication, and deployment scope.

## Operations

- [Kafka foundation](operations/kafka-foundation.md): private broker, topic settings, persistence, failure gates, and test command.

- [API dependency readiness](operations/api-readiness.md): health contract, local dependency settings, bounds, and recovery.

- [Compose database foundation](operations/compose-foundation.md): verified initialization commands, ownership, networks, and stop/restart semantics.

- [Persistent fictional identities](operations/local-identities.md): file/database protocol, aliases, and failure behavior.

- [Database identity foundation](operations/database-foundation.md): initialization boundaries and real PostgreSQL verification.

- [API and worker images](operations/container-images.md): Docker-only build/run commands and developer packaging checks.

- [Local lifecycle](operations/local-environment.md): bootstrap, readiness, persistence, and explicit reset.
- [Observability](operations/observability.md): trace links, metrics, and disclosure policy.
- [Recovery runbooks](operations/recovery.md): symptom-driven recovery and quarantine repair.
- [Security policy](../SECURITY.md): current support status and safe reporting guidance.

## Decision records

| ADR | Accepted baseline decision |
| --- | --- |
| [0001](adr/0001-durable-ai-execution.md) | Separate event delivery from durable AI execution |
| [0002](adr/0002-typescript-workspaces-and-adapters.md) | Small TypeScript workspaces and explicit adapters |
| [0003](adr/0003-offline-ai-and-evaluation-boundaries.md) | Repeatable offline mode and separate real-provider evaluations |
| [0004](adr/0004-local-identity-and-deployment-scope.md) | Local identity and deployment boundary |

ADRs were accepted on 2026-11-16. Updating or accepting a design record does not implement its controls or change non-documentation commit permissions.

Approved evaluation scope: [ADR-0005](adr/0005-kafka-client-compatibility-gate.md) defines a bounded Confluent client compatibility evaluation. Approval does not adopt a new application SDK or implement application messaging.
