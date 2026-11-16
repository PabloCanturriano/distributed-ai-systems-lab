# Architecture review checklist

Status: ready for owner review, not approved for implementation. Documentation-only commits are authorized independently of this gate.

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

- [ ] Component responsibilities and shared-database tradeoff are acceptable.
- [ ] HTTP/event contracts define stable receipts, errors, replay, and versioning.
- [ ] Transactions, uniqueness, leases, and stale-result protection are understandable and testable.
- [ ] Tenant visibility, local credentials, operational trust, and security limitations are acceptable.
- [ ] Offline lexical/scripted mode is labeled honestly; real-provider evaluation remains separate.
- [ ] Tool scope, budgets, retries, shutdown, and recovery procedures are bounded.
- [ ] CLI and failure scenarios can demonstrate the guarantees without an application frontend.
- [ ] Test and release evidence is sufficient; no application tests are currently claimed passing.
- [ ] ADRs and implementation phases are accepted, with recorded deviations if required.

Unchecked items mean owner approval has not been recorded, not that documents are missing. After explicit approval, record the date, approving instruction, ADR status, and any exclusions in a focused documentation update. Do not infer implementation authorization from committing or pushing this checklist.

## Implementation-time validation

Exact security-patched dependency versions, container digests, broker/client compatibility, migration SQL, database privileges, credential file permissions, and hardware/startup measurements require actual implementation evidence. The proposed choices are documented; compatibility is not assumed.

Optional real-provider/model selection is deferred to that feature's patch. Before a working release, the owner selects a license and a private reporting channel. These choices do not justify writing unreviewed application code now.

## Completion evidence today

Only documentation exists. Local checks may validate links, examples, whitespace, and document consistency. No executable app, container environment, automated test suite, latency result, security control, or release pipeline is implemented.
