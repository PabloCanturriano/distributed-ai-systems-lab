# ADR-0004: Scope authentication and deployment to a local lab

Status: accepted as the architecture baseline on 2026-11-16. Implementation and compatibility evidence remain required.

## Context

The project must demonstrate authentication and tenant isolation without requiring an external identity account. It must not imply that a convenient local setup is suitable for Internet exposure.

## Decision

Use generated opaque local bearer credentials, server-owned role membership, tenant-scoped queries, and composite relational constraints as described in the [security design](../architecture/security.md). Store credential digests in PostgreSQL and raw local credentials only in the dedicated bootstrap/CLI volume.

Treat the host operator and Compose network as trusted infrastructure. Publish only the API and selected inspection interfaces, bound to loopback. Do not publish database, broker, or Redis host ports by default. No public login or credential-administration service is added initially.

Do not introduce row-level security in the first slice. Explicit tenant predicates, same-tenant foreign keys, and adversarial integration tests form the initial isolation boundary. This reduces session-context complexity but means a missing tenant filter can still leak reads. Record this residual risk rather than claiming database-enforced read isolation.

Keep one Compose environment with fictional data. Single-node Kafka/PostgreSQL and local volumes do not demonstrate high availability. CI publishes reproducible artifacts; hosted deployment requires a separate ADR and owner authorization.

## Alternatives and consequences

OIDC is appropriate for a hosted system but adds an identity service and setup to this local demonstration. Revisit it before external deployment. Fixed public API keys are easier to document but create predictable credentials and misleading defaults, so they are rejected.

Row-level security can provide additional read isolation, but requires a tested transaction/session context strategy with pooled connections. It remains a possible future enhancement rather than an unverified claim.

Local credentials and plaintext internal transport remain visible to a trusted host operator. Model calls, when enabled, transmit fictional context to a reviewed external provider. These limitations must remain explicit in the README and release notes.
