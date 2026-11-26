# Distributed AI Systems Lab

An event-driven technical support backend for exploring reliable asynchronous processing and grounded AI responses.

## Project status

**Phases 2–5 are published through `c3b304c`.** Phase five adds the bounded offline agent, tenant-scoped read-only tools, atomic evidence/citation/summary persistence and validated API/CLI output. Its [local acceptance](docs/quality/phase5.md) passed seventeen controls and 59 criteria; [hosted CI](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45728624070) tracks the published revision.

[Phase-six release preparation](docs/quality/phase6.md) is in progress: OpenAPI export, production dependency triage and a reproducible Docker-only reviewer journey are prepared for review. Start with the [reviewer quickstart](docs/release/reviewer-quickstart.md). License and private reporting choices remain under analysis; no release or real-provider quality is claimed.

## Local CLI

```sh
docker compose build cli
docker compose --profile messaging --profile execution up --build --detach --wait --wait-timeout 180
docker compose run --rm -T cli demo --identity summit.requester --json
```

The demo returns an explicitly simulated indexed excerpt with an immutable citation. See the [corpus and retrieval guide](docs/operations/knowledge.md) for algorithms and evaluation limits, and the [CLI guide](docs/operations/ticket-cli.md) for create/get/wait commands, identities, exit codes and limits. This local workflow is not a release.

## Target use case

A user submits a technical support ticket through an HTTP API or a containerized CLI. A worker retrieves relevant documentation, invokes permitted read-only tools when needed, and produces an answer with references. The user can inspect the ticket's progress and processing outcome.

The same workflow provides a concrete setting for investigating duplicate events, interrupted processing, unavailable dependencies, and recovery.

## Design direction

The accepted design uses two application services: a NestJS API and a worker. The CLI consumes the API rather than duplicating business logic.

| Technology | Intended responsibility |
| --- | --- |
| TypeScript and NestJS | API, worker, and application modules |
| PostgreSQL | Business state, outbox, consumer deduplication, documents, and audit records |
| pgvector | Document embedding storage and similarity search |
| Kafka | Asynchronous event delivery |
| Redis | Rate limiting and disposable cache data |
| Docker Compose | Reproducible local environment |
| OpenTelemetry | Traces and metrics across HTTP, events, and AI operations |

PostgreSQL is the source of truth. Redis must not be required for business correctness. The boundaries, contracts, and tradeoffs are recorded in the [documentation map](docs/README.md) and ADRs; the baseline was accepted on 2026-11-16, with implementation evidence still required.

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

Event delivery is at least once. This does not imply exactly-once execution of external model or tool calls; their failure windows and recovery behavior must be documented.

## Reviewer experience and remaining work

The local journey above uses fictional seed data and a CLI demonstration without an external model key. Default-profile full-workflow startup and general scenario commands remain future work.

A deterministic simulated provider currently supports repeatable workflow tests. An optional real-model integration will have separate quality evaluations; simulated results will not be presented as evidence of model quality.

The [Compose foundation commands](docs/operations/compose-foundation.md) verify initialization and process lifecycle. The CLI commands above demonstrate the complete simulated workflow; release-level prerequisites and measurements remain future work.

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

The [roadmap](docs/roadmap.md) defines delivery phases and acceptance gates. The [review checklist](docs/architecture/review.md) makes the implementation approval boundary explicit. The [phase-2 gate](docs/quality/phase2.md) now verifies the complete simulated workflow and its required failure/concurrency boundaries; the closure patch is pending owner review.

## Current limitations

The intended default combines a scripted model with lexical vector retrieval; it is not a semantic-model benchmark. Real-provider evaluation is optional and separate. The local deployment trusts the host operator and does not provide production high availability, hosted identity, or a public deployment.

See the [security policy](SECURITY.md) before reporting a concern. There is no supported application release yet.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for change structure, validation expectations, and review guidance.
