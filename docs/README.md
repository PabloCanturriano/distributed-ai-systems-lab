# Documentation map

The repository is in design phase. All application behavior is proposed unless an implemented revision and verification result are explicitly linked. The owner accepted the architecture baseline on 2026-11-16; phase 1 preparation is authorized. This is not an application release.

## Read in this order

1. [Architecture overview](architecture/overview.md): components, handoff, lifecycle, and guarantees.
2. [HTTP and event contracts](architecture/contracts.md): observable behavior, errors, idempotency, and replay.
3. [Data model](architecture/data-model.md): integrity constraints and transaction boundaries.
4. [Security and local identity](architecture/security.md): permissions, trust boundaries, and threats.
5. [AI and retrieval](architecture/ai-system.md): corpus, offline limitations, tool contracts, and evaluations.
6. [CLI journey](architecture/cli.md): intended reviewer experience and scenario boundaries.
7. [Architecture review checklist](architecture/review.md): proposed decisions and implementation gate.

## Implementation preparation

- [Roadmap](roadmap.md): phased deliverables and acceptance gates.
- [Repository conventions](architecture/repository.md): layout, module boundaries, migrations, and review.
- [Runtime limits](architecture/runtime-limits.md): proposed finite budgets and timing values.
- [Test strategy](quality/testing.md): TDD, real integration evidence, and scenario traceability.
- [CI and release](quality/ci-release.md): required gates, trusted publication, and deployment scope.

## Operations

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
