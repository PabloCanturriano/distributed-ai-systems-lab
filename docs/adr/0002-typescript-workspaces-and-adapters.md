# ADR-0002: Use a small TypeScript monorepo with explicit adapters

Status: accepted as the architecture baseline on 2026-11-16. Implementation and compatibility evidence remain required.

## Context

The lab must expose a consistent HTTP, event, and CLI experience while keeping distributed failure behavior visible. A separate repository or deployment for every module would increase review and operational cost without demonstrating a necessary business boundary.

## Decision

Use npm workspaces, TypeScript strict mode, NestJS for the API and worker, and Commander for the CLI. Compile TypeScript explicitly; do not depend on runtime type stripping to support framework decorators.

Use Zod schemas at HTTP, event, tool, and configuration boundaries. Generate the OpenAPI document from the agreed HTTP schemas through a supported adapter and verify parity in contract tests. Keep schema-to-OpenAPI conversion isolated; library-specific decorators must not define a second conflicting contract.

Use node-postgres (`pg`) for parameterized SQL and explicit transactions, and a stable node-pg-migrate release for versioned migrations. Do not enable automatic schema synchronization. Wrap transaction lifecycle once; business operations still state their writes and locking requirements. All statements in a transaction use the same checked-out client, as required by [node-postgres](https://node-postgres.com/features/transactions).

Use KafkaJS behind a narrow messaging adapter with explicit producer acknowledgement and manual consumer offset commits. Start with sequential handling within each partition. [KafkaJS documents manual commits and partition processing controls](https://kafka.js.org/docs/consuming); actual broker/client compatibility and maintenance suitability must be checked before pinning dependencies. A failed compatibility or security review reopens this client choice before implementation proceeds. The [2026-11-19 client review](../quality/reviews/0009-kafka-client-selection.md) records an unresolved maintenance concern; [ADR-0005](0005-kafka-client-compatibility-gate.md) authorizes a bounded alternative-client evaluation. Its [results](../quality/reviews/0010-kafka-client-compatibility.md) were approved and committed; application SDK adoption remains open under [proposed ADR-0006](0006-local-kafka-relay.md).

Use Jest for behavioral tests and Testcontainers for integration dependencies. The test runner's compatibility with the chosen TypeScript/NestJS toolchain must be verified in the foundation slice. Use the official OpenTelemetry SDK and Collector; business code depends on a small telemetry interface rather than a vendor backend.

## Alternatives and consequences

An ORM could reduce mapping code, but the central demonstrations require explicit transactions, constraints, and ownership predicates. Direct SQL makes those reviewable at the cost of maintaining mappings and query tests. A generic repository abstraction would obscure these operations and is not planned.

A larger build framework is unnecessary for three workspaces and a few shared packages. npm workspaces reduce bootstrap tooling. Package boundaries must still be enforced through imports and review.

Do not add an agent framework initially. A bounded state machine and three fixed tools are sufficient. Reconsider only after a concrete requirement demonstrates value.

## Version policy

The initial target is Node.js 24 LTS, PostgreSQL 17 with pgvector, a stable Apache Kafka 4.x image, and a supported Redis release. These are proposed compatibility targets, not an already tested matrix. Node 24 is a maintained LTS line, not the newest active LTS; consult the [Node release schedule](https://github.com/nodejs/Release) and [PostgreSQL support policy](https://www.postgresql.org/support/versioning/) before installation.

Resolve current security-patched versions at implementation time. Record exact package versions in a lockfile and container versions/digests in Compose. No prereleases or floating `latest` tags. Capture the tested matrix in release evidence; never infer compatibility from major version numbers alone.
