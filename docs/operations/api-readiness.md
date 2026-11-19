# API dependency readiness

Status: API dependency readiness is implemented for PostgreSQL/schema/identity bootstrap and Redis reachability. Ticket operations, HTTP authentication, rate limiting, Kafka, worker readiness, and application telemetry remain future work.

## Observable contract

`GET /health/live` responds with 200 and `{"status":"alive"}` without contacting dependencies. `GET /health/ready` responds with 200 and `{"status":"ready"}` only after both checks succeed:

- An authenticated `lab_api_login` connection selects its allowed `lab_api` role and reads the version-1 `lab.api_readiness` view. The view requires the expected immutable identity fixture manifest/digest. Missing schema, incompatible metadata, missing seed state, permission failure, and PostgreSQL unavailability result in not ready.
- The Redis client is connected and returns `PONG` within the health operation's deadline.

Failures return only 503 and `{"status":"not_ready"}`. Exceptions, passwords, endpoints, and individual dependency states are not returned. This is a current prerequisite sample, not a guarantee that dependencies remain available after the response or that the ticket workflow exists.

A small owner-defined view exposes only contract version and a seed-ready boolean. The API receives SELECT on this view and cannot read or mutate `lab.seed_manifests` directly. Creating the view is a separate forward migration; the earlier migrations and credential fixtures are unchanged. Applying it over the seeded two-migration baseline preserves existing rows and credential digests.

## Configuration and credentials

The [Compose foundation](compose-foundation.md) enables `API_DEPENDENCIES=local`, supplies Redis, and mounts only the API's database password volume read-only at `/run/lab/api`. The API never mounts administrative, migrator, seed, or raw demo-credential volumes. Its PostgreSQL identity/database/role and password path are fixed by the implementation. The file must be a regular non-symlink file owned by the API process user, mode 0600, containing exactly one canonical 43-character base64url password. Passwords are not accepted through URL/argument/environment values.

| Setting            | Default    | Policy                                                         |
| ------------------ | ---------- | -------------------------------------------------------------- |
| `API_DEPENDENCIES` | `disabled` | Exactly `disabled` or `local`                                  |
| `API_PG_HOST`      | `postgres` | Valid IP literal or DNS-style hostname, at most 253 characters |
| `API_PG_PORT`      | `5432`     | Canonical decimal TCP port, 1–65535                            |
| `API_REDIS_HOST`   | `redis`    | Same host policy                                               |
| `API_REDIS_PORT`   | `6379`     | Same port policy                                               |

Standalone development/image startup defaults to disabled dependencies and retains readiness 503; it does not open dependency connections or require a mounted password. Compose explicitly enables local mode. The worker ignores these API-only settings and remains idle. Hosted operation is not enabled by these settings; local plaintext transport and trusted Docker-host/network assumptions remain in force.

The API image healthcheck uses readiness when local dependencies are enabled and liveness otherwise. Thus Compose `--wait` now checks the implemented API prerequisites; a healthy standalone image with disabled dependencies still demonstrates liveness only. Startup's `ready:false` event remains an initial unverified state; HTTP readiness is the current check.

## Bounds, recovery, and shutdown

PostgreSQL uses at most two pooled connections, a 500 ms connection/checkout timeout, 500 ms server statement timeout, 750 ms client query timeout, and 1-second idle lifetime. Every readiness checkout selects the API role explicitly. A failed checkout/query results in not ready; failed query connections are discarded rather than returned for reuse. The API does not import administrative/migration tooling.

Redis uses the minimal official `@redis/client` 6.3.1, disabled offline queueing, at most eight queued/in-flight commands, and a 1-second TCP connection timeout. SDK connection reconnection delays grow to a maximum of 2 seconds; this background reconnect behavior does not retry the health command itself. These choices follow [the official client's connection guidance](https://redis.io/docs/latest/develop/clients/nodejs/produsage/).

An independent 1-second deadline covers the complete PING response. In the tested SDK version the command queue's timeout is removed when a command is sent, so it cannot alone bound an unresponsive server. On a PING deadline the API discards that connection and reconnects, clearing stale replies; this health operation reports failure. No mutating Redis operation is performed or retried. Simultaneous readiness requests share one probe, preventing unbounded pool waiters/health commands.

Dependency errors are consumed and logged only as allowlisted event names. Detailed errors are not logged. On shutdown, readiness is disabled, Redis is destroyed, and the PostgreSQL pool is drained. Bind/startup failures close any initialized resources. Verified stop/start and pause/resume scenarios recover without changing the API container or restarting its process. An API shutdown while Redis is reconnecting also completes without SIGKILL.

Redis 8.10.3 runs non-root with an internal-only, unpublished port, a 64 MiB memory budget, no eviction, and snapshot/AOF persistence disabled. It has no authentication in this trusted local network. Its memory is disposable, and no business state is stored there. PING readiness proves reachability, not successful limiter/cache writes at the memory limit; rate limiting/caching are not implemented by this slice.

## Verification

```sh
npm run check
npm run test:database
npm run test:compose
npm run test:containers
```

The Compose harness tests readiness 200→503→200 through dependency stop/start and pause/resume while liveness remains 200. It verifies unchanged API identity/restart count, safe response bodies, shutdown during reconnection, credential/data preservation, and secret absence in captured stdout/stderr logs. It operates only on its unique test project.

See [review evidence](../quality/reviews/0007-api-readiness.md) for exact versions, red/green results, audit findings, and remaining limitations.
