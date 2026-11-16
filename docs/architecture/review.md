# Architecture review checklist

Status: architecture baseline accepted on 2026-11-16. The owner authorized phase 1 after the roadmap review. Preparing implementation is authorized; committing non-documentation changes still requires exact-patch approval.

## Decision summary

| Area | Proposed baseline | Tradeoff |
| --- | --- | --- |
| Topology | API and worker roles in one monorepo, on-demand CLI | Shared database/module boundaries rather than autonomous microservices |
| Delivery | Transactional outbox, Kafka, durable inbox/job handoff | Duplicate transport is expected; extra scheduling state is explicit |
| Execution | PostgreSQL leases, attempt tokens, generation fencing | External calls can repeat after crashes |
| Data access | Parameterized SQL through pg, ordered migrations | More explicit mappings and concurrency tests |
| Local AI | Scripted model and deterministic lexical vector baseline | Reproducible workflow, no claim of semantic model quality |
| Retrieval | Immutable corpus snapshots and exact pgvector search | Small corpus first; no unmeasured scaling/index claims |
| Agent | Bounded state machine and three fixed read-only tools | Limited capabilities instead of open-ended autonomous actions |
| Identity | Generated opaque credentials and tenant-scoped roles | Local-only trust, no hosted SSO or database read isolation through RLS |
| Inspection | OpenTelemetry, Collector, Jaeger, Prometheus | Local tooling overhead, bounded telemetry queues |
| Delivery scope | Docker-only local demo and reproducible image release | No automatic hosted deployment |

## Architecture exit checklist

The owner reviews these artifacts before authorizing the first code patch:

- [x] Component responsibilities and shared-database tradeoff are acceptable.
- [x] HTTP/event contracts define stable receipts, errors, replay, and versioning.
- [x] Transactions, uniqueness, leases, and stale-result protection are understandable and testable.
- [x] Tenant visibility, local credentials, operational trust, and security limitations are acceptable.
- [x] Offline lexical/scripted mode is labeled honestly; real-provider evaluation remains separate.
- [x] Tool scope, budgets, retries, shutdown, and recovery procedures are bounded.
- [x] CLI and failure scenarios can demonstrate the guarantees without an application frontend.
- [x] Test and release evidence is sufficient; no application tests are currently claimed passing.
- [x] ADRs and implementation phases are accepted, with recorded deviations if required.

Approval record: on 2026-11-16, the owner instructed us to proceed after the phase-0 approval and phase-1 foundation steps were explained. This accepts the baseline design, including the documented limitations and optional real-provider scope. Compatibility, security controls, and acceptance scenarios still require implementation evidence. Commit or push permission is not implied.

## Implementation-time validation

Exact security-patched dependency versions, container digests, broker/client compatibility, migration SQL, database privileges, credential file permissions, and hardware/startup measurements require actual implementation evidence. The proposed choices are documented; compatibility is not assumed.

Optional real-provider/model selection is deferred to that feature's patch. Before a working release, the owner selects a license and a private reporting channel. These choices do not justify writing unreviewed application code now.

## Evidence at architecture approval

Only documentation exists. Local checks may validate links, examples, whitespace, and document consistency. No executable app, container environment, automated test suite, latency result, security control, or release pipeline is implemented.
