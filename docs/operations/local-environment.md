# Local environment and lifecycle

Status: operational design with an implemented minimal API/worker lifecycle and validated local startup settings. Separate [API/worker images](container-images.md) now support a Docker-only process-lifecycle check. A [database bootstrap and identity migration](database-foundation.md) now have isolated integration evidence. Compose, persistent credential provisioning, dependency readiness, and the complete Docker-only ticket journey remain unimplemented. See [configuration review evidence](../quality/reviews/0002-startup-configuration.md).

## Intended startup

The target command is `docker compose up --build -d --wait`. It must not require a manual migration, a copied secret file, a model download, or a host Node installation. Git plus a supported Docker engine and Compose v2 are prerequisites. Supported OS/architecture and minimum resources must be measured before publishing a runnable quickstart.

Proposed sequence:

1. Start PostgreSQL/pgvector, Kafka in single-node KRaft mode, and Redis on an internal network.
2. Bootstrap local database roles using an isolated privileged process; run ordered migrations with the migration identity.
3. Seed immutable fictional identities/corpus, provision generated local credentials, and initialize explicit topics without erasing existing business data.
4. Start API and worker roles only after initialization completes successfully.
5. Start Collector, Jaeger trace inspection, and Prometheus metrics inspection, with user-facing ports on loopback only.
6. Declare the environment ready only when the required business services and bootstrap prerequisites are usable.

Compose distinguishes running from healthy dependencies; use health and successful-one-shot conditions as described in [Docker's startup-order documentation](https://docs.docker.com/compose/how-tos/startup-order/). Startup ordering does not replace runtime reconnect/recovery handling.

A single-node broker and database are for reproducibility, not replication or host-failure durability. Persistence survives ordinary process/container restarts through named volumes; deleting volumes loses the demonstration state.

## Readiness and liveness

API `GET /health/live`: process is running and can respond; no dependency details. API `GET /health/ready`: 200 only when schema/seeds and required PostgreSQL/Redis access are usable; otherwise 503 with a safe status. Kafka outage may leave the API ready because accepted work is durable in outbox; expose the backlog/degraded transport in metrics and operational output.

Worker readiness checks database/schema plus the dependencies for its selected role. The consumer requires broker connectivity for ready status. The executor may remain ready during broker failure if durable jobs are already scheduled. No telemetry outage changes a committed business result. These endpoints/probes have separate ingress controls and no business credentials or connection-string output.

Worker roles need not expose HTTP ports: use a role-local health command or internal probe. Readiness failure alone must not delete jobs or reset offsets. Liveness must not produce restart loops during a recoverable dependency outage.

## Implemented local startup settings

The shared `@lab/configuration` workspace validates settings before creating either Nest application. Validation uses [Zod safe parsing](https://zod.dev/basics); raw validation errors and environment values are not exposed. Unsupported settings fail startup with exit code 1 and a fixed role-specific failure event.

| Variable | Applies to | Default | Accepted values |
| --- | --- | --- | --- |
| `APP_MODE` | API and worker | `local` | Exactly `local`; blank or unsupported modes fail |
| `API_HOST` | API | `127.0.0.1` | `127.0.0.1`, `::1`, or explicit `0.0.0.0` |
| `API_PORT` | API | `3000` | Canonical decimal integer from 1 through 65535 |

Use loopback for host development. `0.0.0.0` is an explicit bind for future container networking and exposes the listener on every IPv4 interface when used directly on the host; local mode does not provide a network access boundary. Hostnames and other IP addresses are unsupported in this slice. Port values with whitespace, leading zeros, signs, fractions, or exponent notation fail rather than falling back to defaults.

After `npm ci --ignore-scripts` and `npm run build`, this POSIX shell command starts the development API on loopback port 3001:

```sh
APP_MODE=local API_HOST=127.0.0.1 API_PORT=3001 npm run start --workspace=@lab/api
```

Settings come from the process environment; no `.env` file loader is installed. Unrelated environment variables are ignored, and the worker does not validate API-only settings. Database, broker, Redis, AI, and telemetry configuration remain future work. Readiness continues to return 503 until real bootstrap/dependency checks exist.

## Configuration groups

| Group | Examples of required values | Policy |
| --- | --- | --- |
| Application | role, local mode, bind address | Validate at startup; no accidental hosted mode |
| PostgreSQL | role-specific connection credentials, pool and transaction timeouts | Secret values omitted from logs; runtime identities are not migration identities |
| Kafka | internal broker, explicit topics/group, bounded transport settings | Manual offset policy and tested acknowledgement settings |
| Redis | internal address, limiter policy | No fail-open authorization or business locks |
| AI | simulated/real mode, profile/policy IDs, reviewed endpoint | Default offline; real mode explicit with validated limits |
| Telemetry | internal OTLP destination, safe resource attributes | Bounded queues; exporter failure does not block business commits |
| Bootstrap | credential volume location and fixture manifest digest | Existing secrets and immutable data are preserved |

The table above defines the implemented startup variables; remaining dependency settings and container publication are supplied with the reviewed Compose patch. Fail before readiness when required settings conflict; do not silently choose another tenant, model, or database. Real-provider secrets remain uncommitted. The planned standard limits are in [runtime limits](../architecture/runtime-limits.md).

## Stop, restart, and reset

Ordinary stop/restart preserves volumes, idempotency receipts, jobs, and credentials. Services drain bounded in-flight work and recover leases after interruption. The default startup never destroys data to repair a schema mismatch or an initialization error.

A destructive reset is a separate host-operator action: show the target Compose project/volumes and require explicit confirmation. Document exactly which local data and credentials disappear. Do not implement a broad machine-wide Docker prune. Reset is not an AI tool, tenant API action, or normal recovery step.

A partial bootstrap failure leaves diagnostics and blocks dependent readiness. Retrying bootstrap is idempotent. Missing raw credential files with an existing database is an explicit provisioning error; do not silently replace all identities.

## Acceptance additions

- OPS-01: a clean clone reaches ready status with one Docker startup command and no external keys.
- OPS-02: a second startup creates no duplicate identities, fixtures, or schema changes and preserves tickets.
- OPS-03: partial migration/seed failure blocks dependent readiness without deleting prior data.
- OPS-04: stop/restart preserves a queued ticket and allows recovery without manual offset changes.
- OPS-05: explicit reset affects only the selected project and invalidates its old credentials.
- OPS-06: readiness, published ports, and required secret mounts match the documented local security boundary.

Concrete runnable commands, measured startup times, and supported platforms become release evidence after implementation. Until then, the documentation must not advertise an executable demo.
