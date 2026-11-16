# Repository structure and engineering conventions

Status: proposed layout. Apart from current Markdown documentation, these paths are not scaffolded.

## Layout

```text
apps/
  api/                 HTTP transport, auth guards, ticket operations
  worker/              Consumer, executor, and relay entry points
  cli/                 API client and reviewer commands
packages/
  contracts/           HTTP, event, tool, and output schemas
  configuration/       Validated runtime configuration
  observability/       Shared initialization and safe metadata policy
  test-support/        Fixtures, barriers, and integration utilities
  ticket-processing/   Shared business operations needed by API/worker
  retrieval/           Corpus profiles and retrieval operations
  ai-runtime/          Model adapters, bounded state machine, tool validation
database/
  migrations/
  seeds/
fixtures/
  knowledge/
evaluations/
  datasets/
  runners/
scenarios/
infra/
  docker/
  observability/
docs/
  adr/
  architecture/
  operations/
  quality/
.github/workflows/
```

Create a shared package only when code has a clear shared consumer or lifecycle. The tree describes likely boundaries, not a requirement to generate empty packages. In the initial slice keep retrieval/AI modules inside the worker until extraction serves a concrete need. A package cannot import an application entry point. Avoid a generic `common` or `utils` dumping ground.

## Coding conventions

Use strict TypeScript, explicit public contracts, named business operations, and validated unknown input. Do not silence boundary errors with `any`, unchecked casts, or broad exception swallowing. Keep pure lifecycle decisions independent of NestJS/SQL where useful; do not add a domain framework or base repository merely to create layers.

Controllers validate/authorize and call an application operation. Persistence adapters own parameterized SQL and map rows to explicit types. Model/tool adapters classify external failures; they do not decide tenant permissions. A transaction is passed explicitly to collaborating persistence operations, with no hidden new transaction midway through a business operation.

Use one consistent lock order and bounded transaction/statement timeouts. Retrying a deadlock or serialization failure means retrying the whole safe transaction with the same logical operation identity, not replaying only its final statement. Handle ambiguous commit acknowledgement by rereading durable identity state. Database tests must verify these behaviors.

Format and lint automatically once tooling exists. Prefer clear names and short modules over arbitrary line-count rules. Comments explain a guarantee, failure window, or non-obvious decision; they should not narrate each statement. Public error codes are stable contracts; raw exception strings are not.

Use injected clock/random/provider ports only where control is useful for tests. Do not build an abstraction around every library method. Application timers may be controlled in unit tests; database ownership tests use real database time.

## Schema and migrations

Migration files are ordered, immutable after release, and reviewed with generated SQL where applicable. Test a clean install and upgrade from the previous release. Do not run schema synchronization on service startup. A dedicated migration process completes before API/worker readiness.

Roll forward application-compatible fixes by default. Destructive rollback is not a generic recovery strategy. Expand-contract changes and data backfills require explicit design and evidence. Demo seeds are idempotent and validate immutable fixture versions; they never erase user-created tickets during normal startup.

## Review and completion

A focused implementation change links acceptance IDs, shows red-to-green evidence, includes relevant checks and migration impact, and updates documentation. Do not commit build products, credentials, dependency caches, or local evaluation output. Released reports are deliberately selected sanitized artifacts.

Markdown-only commits are preauthorized; code, tests, dependencies, and configuration still require the owner's approval of the exact patch. Architecture approval remains a separate gate. Push, merge, and release permissions follow the session authorization rather than being implied by commit permission.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the TDD and review workflow.
