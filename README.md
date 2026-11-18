# Distributed AI Systems Lab

An event-driven technical support backend for exploring reliable asynchronous processing and grounded AI responses.

## Project status

**Foundation phase, in progress.** The repository includes architecture documentation plus TypeScript workspaces, minimal NestJS API/idle worker entry points, and lifecycle tests. API and worker [container images](docs/operations/container-images.md) are implemented for local lifecycle verification. The [database identity foundation](docs/operations/database-foundation.md) and [persistent fictional identities](docs/operations/local-identities.md) have real PostgreSQL integration checks. An initial [Compose foundation](docs/operations/compose-foundation.md) is prepared for review; business readiness, the ticket workflow, and CI remain unimplemented. The owner accepted the architecture baseline on 2026-11-16; the first implementation patch remains subject to review before commit.

The ticket-processing behavior below remains planned. See [foundation review evidence](docs/quality/reviews/0001-runtime-foundation.md) for the implemented subset and local development commands.

## Use case

A user submits a technical support ticket through an HTTP API or a containerized CLI. A worker retrieves relevant documentation, invokes permitted read-only tools when needed, and produces an answer with references. The user can inspect the ticket's progress and processing outcome.

The same workflow provides a concrete setting for investigating duplicate events, interrupted processing, unavailable dependencies, and recovery.

## Design direction

The proposed design uses two application services: a NestJS API and a worker. The CLI consumes the API rather than duplicating business logic.

| Technology | Intended responsibility |
| --- | --- |
| TypeScript and NestJS | API, worker, and application modules |
| PostgreSQL | Business state, outbox, consumer deduplication, documents, and audit records |
| pgvector | Document embedding storage and similarity search |
| Kafka | Asynchronous event delivery |
| Redis | Rate limiting and disposable cache data |
| Docker Compose | Reproducible local environment |
| OpenTelemetry | Traces and metrics across HTTP, events, and AI operations |

PostgreSQL is the source of truth. Redis must not be required for business correctness. The proposed boundaries, contracts, and tradeoffs are recorded in the [documentation map](docs/README.md) and ADRs; the baseline was accepted on 2026-11-16, with implementation evidence still required.

## Behaviors to demonstrate

| Concern | Expected evidence |
| --- | --- |
| Request idempotency | Repeating a request with the same key and payload returns the same ticket; changing the payload produces a conflict. |
| Transactional outbox | A committed ticket has a durable event to publish, including after a process restart. |
| Consumer idempotency | Repeated delivery does not duplicate committed business effects. |
| Recovery | Bounded retries, dead-letter handling, and replay have reproducible failure scenarios. |
| Retrieval quality | A versioned question set measures retrieval and citation behavior, including insufficient evidence. |
| Agent boundaries | Tool arguments, tenant permissions, step counts, and execution budgets are enforced. |
| Observability | A reviewer can follow a ticket from its HTTP request through event processing and AI operations. |

Event delivery will be at least once. This does not imply exactly-once execution of external model or tool calls; their failure windows and recovery behavior must be documented.

## Planned reviewer experience

The target is a single Docker Compose startup command, fictional seed data, and a CLI-guided demonstration requiring no external credentials. Scenarios will report their expected outcome, observed result, and success or failure.

A deterministic simulated AI provider will support repeatable workflow tests. An optional real-model integration will have separate quality evaluations; simulated results will not be presented as evidence of model quality.

The [Compose foundation commands](docs/operations/compose-foundation.md) verify initialization and process lifecycle. Complete ticket-demo commands and measured prerequisites remain future work.

## Delivery sequence

1. Review architecture, ticket states, event contracts, tenant boundaries, threat model, and initial ADRs.
2. Establish Docker startup, migrations, repeatable seeds, and baseline CI.
3. Complete one ticket workflow through CLI, API, outbox, Kafka, and worker using the simulated provider.
4. Verify duplicate delivery, dependency failures, restart recovery, and trace correlation.
5. Add evaluated retrieval and a bounded agent with read-only tools.
6. Complete security scenarios, operational documentation, and reproducible releases.

## Scope

The initial release focuses on local execution and backend behavior. It excludes a frontend, Kubernetes, production hosting, and autonomous write-capable tools. Deployment to a hosted environment requires a separate decision.

## Technical review

Start with the [architecture overview](docs/architecture/overview.md), [HTTP/event contracts](docs/architecture/contracts.md), and [execution decision record](docs/adr/0001-durable-ai-execution.md). The [documentation map](docs/README.md) links the data model, security design, CLI, AI limitations, tests, and runbooks.

The [roadmap](docs/roadmap.md) defines delivery phases and acceptance gates. The [review checklist](docs/architecture/review.md) makes the implementation approval boundary explicit. Application scenarios are not run yet.

## Current limitations

The intended default combines a scripted model with lexical vector retrieval; it is not a semantic-model benchmark. Real-provider evaluation is optional and separate. The local deployment trusts the host operator and does not provide production high availability, hosted identity, or a public deployment.

See the [security policy](SECURITY.md) before reporting a concern. There is no supported application release yet.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for change structure, validation expectations, and review guidance.
