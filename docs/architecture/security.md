# Local authentication and threat model

Status: design requirements with partial [database privilege evidence](../quality/reviews/0004-database-foundation.md). Non-login privilege groups, identity-table grants, and [trusted local identity seeding](../operations/local-identities.md) are implemented. The [Compose foundation](../operations/compose-foundation.md) now provisions restricted database logins and private password volumes. The [API readiness adapter](../operations/api-readiness.md) mounts only its own database password and reads metadata through its restricted role. HTTP authentication, tenant isolation, and the remaining controls below are not implemented protections. Read with the [HTTP/event contracts](contracts.md) and [data model](data-model.md).

## Scope and assumptions

Protect tenant-owned tickets, documents, execution results, credentials, and operational integrity against unauthenticated callers, users of another demo tenant, malformed events, malicious retrieved text, and invalid model/tool output.

The default installation is a single-user local lab with fictional data. The Docker host owner, migration process, and seed process are trusted operators. A compromised host, database administrator, or container runtime can read or modify local data; this design does not isolate tenants from that operator.

The local environment is not a safe public Internet deployment. Hosted use requires separate decisions for identity federation, TLS, service authentication, broker ACLs, secret management, retention, and incident response.

## Local identities and credentials

Use opaque bearer credentials for the local demonstration rather than adding a login server. Bootstrap two fictional tenants, each with reader, requester, and operator principals. Their roles are server-owned:

| Role | Permissions | Resource scope |
| --- | --- | --- |
| Reader | `tickets:read` | All tickets in its own tenant |
| Requester | `tickets:create`, `tickets:read` | All tickets in its own tenant |
| Operator | `tickets:create`, `tickets:read`, `tickets:replay` | All tickets in its own tenant |

Tenant-level visibility is intentional; individual ticket ownership isolation is outside the initial contract. The operator role does not confer database administration, arbitrary event publishing, cross-tenant access, or fault-injection permissions.

A credential consists of a non-secret lookup ID and a cryptographically generated secret with at least 256 bits of randomness. Persist only a digest of the high-entropy secret and its principal association. Verification must use appropriate constant-time comparison. Never use human passwords or predictable public demo strings as bearer secrets.

The seed/bootstrap process creates credentials on first initialization and writes the raw local demo credentials to a dedicated shared volume. Only bootstrap and the CLI mount that volume; the API resolves credential digests through PostgreSQL. Existing local data must not silently generate replacement credentials on every startup. A missing credential volume with an existing database is a provisioning error requiring explicit recovery or reset.

The trusted seed operation now persists six fictional identities and private raw secret material, with file/database consistency checks. Compose credential-volume wiring and HTTP/CLI use remain unimplemented; see the [implemented provisioning protocol](../operations/local-identities.md).

The CLI selects an identity by a non-secret alias, reads its credential from the volume, and injects the bearer header. Do not pass secrets in CLI arguments, URLs, or committed files. Manual HTTP examples can describe local credential retrieval without printing credentials during normal startup. The default interactive demo uses a requester; replay scenarios explicitly select an operator.

Local volume storage is a convenience, not a production secret store. The host operator can access it. Reset invalidates both persisted credentials and their local files. No public credential-management endpoint is included initially.

## Authentication and authorization sequence

1. Enforce HTTP size/header bounds and perform a cheap ingress rate check before expensive processing.
2. Parse the bearer format; resolve the credential and principal without logging the raw header.
3. Reject unknown, revoked, expired, or disabled identities with a generic `401`. Authentication has no cache in the initial design, so database changes apply to subsequent requests.
4. Resolve tenant and permissions from server-owned records and enforce the route permission before looking up a target ticket.
5. Apply the tenant/principal rate limit, then perform a tenant-scoped lookup and mutation. A permitted route returns the same `404` representation for missing and other-tenant resources.

Credential records include `id`, `principal_id`, `secret_digest`, `created_at`, optional `expires_at`, and optional `revoked_at`. Principal membership is immutable in the demo; moving an identity between tenants requires creating a new identity. Never accept a caller's tenant header as authority.

A database outage returns `503` rather than a fabricated authentication result. A limiter outage rejects affected API operations with `503`. Rate-limit rejection uses `429`; neither path mutates business state. No fallback grants access because Redis or PostgreSQL is unavailable.

Already accepted jobs execute under the system worker's bounded authority, scoped to the ticket tenant. Disabling a submitting principal prevents new HTTP actions but does not cancel previously committed work. Cancellation is not part of the initial API. This behavior must be explicit in tests and documentation.

## Trust boundaries

| Boundary | Untrusted input | Enforcement |
| --- | --- | --- |
| Caller to API | Headers, body, resource IDs | Authentication, permissions, size/schema checks, tenant-scoped queries |
| CLI to local environment | Endpoint configuration and server responses | Default local endpoint, bounded polling, no token forwarding to untrusted hosts |
| Kafka to consumer | Event bytes, tenant IDs, trace metadata | Envelope validation, authoritative state checks, inbox/job constraints, durable quarantine |
| Documents to retrieval/model | Text and embedded instructions | Tenant-scoped corpus, bounded context, explicit evidence handling |
| Model to tool executor | Tool names, arguments, generated answers | Fixed allowlist, validated arguments, server-injected tenant context, budgets |
| Application to telemetry | Error objects and request metadata | Allowlisted fields and secret/payload exclusion |
| Host to internal services | Ports, volumes, configuration | Loopback publication, internal-only dependencies, documented operator trust |

An event tenant ID is a consistency assertion, not an authenticated user identity. Internal producer access is a trusted local infrastructure boundary. Validating fields does not authenticate a producer; forged internal events remain a risk if broker access is compromised.

## Threats and required mitigations

| Threat | Required control | Residual limitation |
| --- | --- | --- |
| Credential theft through logs or CLI output | Never log authorization headers, raw tokens, secret files, or provider keys; use aliases | Host/volume access can reveal local credentials |
| Cross-tenant ticket or replay access | Permission checks, tenant-scoped lookups, composite foreign keys | Same-tenant role visibility is intentionally broad |
| Cache or retrieval cross-contamination | Tenant and corpus/profile identity in cache keys; tenant filter before context assembly | A faulty implementation still requires adversarial tests |
| Prompt injection requesting another tenant or secret | Tools derive tenant server-side and cannot read arbitrary secrets/files | Prompt instructions alone cannot guarantee answer quality |
| Arbitrary tool execution or SSRF | No model-selected URLs, shell commands, filesystem paths, or dynamic tool registration | Approved provider endpoints remain external dependencies |
| Unbounded AI cost or repeated replay | Finite calls, output/context limits, attempts, concurrency, and replay rate limits | External calls can repeat after crashes and incur cost |
| Poisoned events or changed event-ID payload | Bounded parsing, digest comparison, durable quarantine, no automatic replay | Quarantine growth requires operational limits and monitoring |
| Replay or retry privilege bypass | Authorize every HTTP attempt, including idempotency hits | A committed prior job is not automatically canceled by revocation |
| Sensitive output in errors/traces | Sanitized failure codes, no default prompt/document capture, safe labels | Authorized users still see their own tenant's generated answer |
| Demo services exposed to the network | Publish user-facing ports on loopback only; no host publication for database, Kafka, or Redis by default | Host users remain trusted |

Tools initially read only the seeded corpus, tenant-scoped tickets, and a fictional service-status fixture. They do not browse the Internet, send messages, mutate tickets, execute code, or fetch arbitrary remote resources. Validate model-generated citation IDs against retrieved, authorized evidence before storing an answered result. A valid citation ID does not by itself prove that every claim is supported; semantic grounding requires separate evaluation.

The CLI must not forward bearer credentials across HTTP redirects. Non-loopback API endpoints require an explicit opt-in and HTTPS before the CLI will send credentials. Local demo credentials must not be reused for hosted systems.

## Runtime and operational safeguards

The design requires dedicated non-superuser database roles for API, consumer/executor, relay, and migrations, with privileges matched to their operations. Migrations and seeds use separate credentials and do not run with the runtime service identity. Roles and grants must be verified in the implementation review; shared database deployment does not imply shared unrestricted permissions.

Internal Kafka/Redis/database ports remain on the Compose network. Only API and chosen inspection interfaces are published on loopback. Containers use a non-root user where the chosen image supports it and do not mount the Docker socket. Health endpoints disclose readiness status rather than credentials or full connection strings.

Fault injection uses opt-in local scenario orchestration, not a public admin HTTP route. The scenario runner must not be callable as an AI tool and must not expose an arbitrary command executor. Infrastructure scenarios run with host-operator authority distinct from tenant operator permissions. Its exact interface is a remaining CLI design decision.

Real-model mode is an explicit opt-in because retrieved context and ticket content may be sent to an external provider. Only fictional data is supported in this lab. Keys are supplied through uncommitted local secret configuration and are never given to the model as context. Provider names, outbound hosts, budgets, and data-flow disclosures must be reviewed before enabling that integration.

## Acceptance specifications

These are future tests and inspection checks, not evidence of passing controls:

- SEC-01: missing, malformed, revoked, expired, and disabled credentials produce generic `401` responses without secret leakage.
- SEC-02: a reader cannot create or replay; a requester cannot replay; an operator remains tenant-scoped.
- SEC-03: a same-tenant requester can read another member's ticket as documented, while another tenant receives the missing-resource `404`.
- SEC-04: forged tenant headers, body fields, tool arguments, and event metadata cannot grant access to another tenant.
- SEC-05: identical cache query text across tenants cannot return another tenant's corpus or answer.
- SEC-06: malicious documents requesting secret access or another tenant's tools never bypass tool authorization.
- SEC-07: unknown tools, extra arguments, arbitrary URLs, and oversized outputs are rejected before use.
- SEC-08: instrumented fake secrets in provider exceptions, requests, and tools are absent from API errors and captured default telemetry.
- SEC-09: revoked credentials cannot obtain an idempotency receipt; already accepted jobs retain the documented execution policy.
- SEC-10: Redis/database outages reject affected API actions without committing partial work or granting fallback access.
- SEC-11: CLI redirects and unapproved remote endpoints do not receive bearer tokens.
- SEC-12: clean startup provisions usable local identities once; a normal restart preserves them; explicit reset invalidates old credentials.
- SEC-13: Compose inspection confirms loopback publication and no default host ports for internal dependencies.
- SEC-14: runtime database roles cannot perform migration/admin actions or unauthorized module writes.

Proposed execution budgets and rate limits are defined in [runtime limits](runtime-limits.md). Credential file permissions on supported platforms and automated secret scanning require implementation evidence. Ingestion and tool contracts must preserve these trust boundaries. Security design approval alone does not authorize application scaffolding.
