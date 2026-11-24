# Local ticket CLI (prepared for review)

The on-demand CLI uses only the public HTTP API. Its initial TypeScript implementation is committed and verified on hosted x64/ARM64; replay support is locally verified and prepared for batch review, not a release. The default endpoint is fixed to `http://api:3000` on the trusted Compose backend. Remote endpoint selection, scenarios and evaluation commands are not implemented. See [replay recovery](recovery.md#replay-of-a-failed-ticket-prepared-for-review) for the new operator command.

## Docker-only journey

From the repository root, with Docker Compose available:

```sh
docker compose build cli
docker compose --profile messaging --profile execution up --build --detach --wait --wait-timeout 180
docker compose run --rm -T cli demo --identity summit.requester --json
```

The demo submits a fixed fictional question and waits for the persisted result. Output explicitly identifies a simulated `insufficient_evidence` response, with no citations or tools. No external model key is needed. The CLI is in the `tools` profile and does not start during an ordinary stack `up`; explicitly selecting its service with `run` activates it. The API dependency must be healthy before the client starts. Without both messaging and execution profiles, ordinary work may remain queued until the CLI deadline.

Use the same built image for individual operations:

```sh
docker compose run --rm -T cli ticket create --message 'How should this fictional ticket be handled?' --key review-ticket-1 --json
docker compose run --rm -T cli ticket get <ticket-id> --identity harbor.reader --json
docker compose run --rm -T cli ticket wait <ticket-id> --deadline 60 --json
docker compose run --rm -T cli --help
```

Replace `<ticket-id>` with the receipt's ID; do not pass angle brackets literally to the shell. The default identity is `harbor.requester`. Available aliases are the six [fictional local identities](local-identities.md). Selecting an alias never selects a tenant header or bypasses server authorization. A reader can read but cannot submit; a foreign ticket and an absent ticket both produce `NOT_FOUND`.

The quoted message is ordinary fictional input, not a credential. Credentials are read privately from the read-only seed volume and never appear in command arguments or output. Do not put private customer data in shell history.

## Output and client behavior

`--json` produces exactly one compact final JSON object on stdout. The default produces the same envelope with indentation, suitable for inspection; neither mode uses color. Fixed queued/processing progress goes to stderr. Compose itself may also print lifecycle notices on stderr. The envelope contains `schemaVersion: 1`, command, outcome, elapsed time and, where available, identity alias, non-secret retry key, request ID and validated ticket projection. It never includes the submitted question, raw errors, unknown API fields or the selected credential secret.

`ticket create` succeeds on acceptance (`outcome: accepted`); it does not promise completion. `ticket get` succeeds when the current state is readable, even if that state is failed. `ticket wait` and `demo` require a completed result; a stored execution failure returns exit 1. `insufficient_evidence` is a completed abstention, not a failed command.

| Exit | Meaning |
| --- | --- |
| 0 | Help, accepted creation, successful read or completed wait/demo |
| 1 | Wait/demo observed terminal execution failure |
| 2 | Invalid arguments or safe API contract rejection (including 404/409/429) |
| 3 | Missing/invalid local credentials, authentication or authorization failure |
| 4 | Transport/dependency failure, interruption or unsupported API response |
| 5 | Overall client deadline expired |

The deadline defaults to 60 seconds and accepts integer values from 1 through 300. Each HTTP attempt is limited to five seconds or the remaining overall time. The client retries transient transport failures (including a cut response body) and 503 at most twice per HTTP operation. It retains the same key and normalized payload, honors supported Retry-After delays up to five seconds and declines a retry that would need a longer server-requested delay. No automatic retry follows 409, 429, authentication failures or redirects. Polling uses a one-second interval. A client timeout or interruption does not cancel a durable ticket.

Generated or supplied submission keys are retained in receipt/error output so a deliberate retry can use the same key. The server remains authoritative for idempotency, limits and tenant visibility. A malformed acceptance URL is rejected; the client constructs its fixed local GET path from the validated ticket ID rather than following a server-selected endpoint. Request IDs are safe correlation hints; distributed tracing is not implemented by this slice.

## Boundaries and verification

The non-root CLI image contains Commander and Node built-ins, without database/native Kafka clients. Its root filesystem and sole demo-credential mount are read-only, all capabilities are dropped and no host port or Docker socket is mounted. It joins only the backend network; it remains a trusted local client able to read the six fictional credentials. This is not a production secret store or network-enforced API-only egress policy. A 128 MiB limit is configured, not a measured minimum.

The manifest reader requires a private owned directory, a small owned regular 0600 file opened without following a leaf symlink, the supported fixture version, six distinct known aliases/lookup IDs and canonical secrets. The seed process verifies fixture/database digests; the CLI validates digest format and structure, not database consistency. Trusted host-managed ancestor paths remain part of the local trust boundary.

`npm run test:cli` creates and removes only its own disposable Compose project. It exercises the real CLI image through API → relay → Kafka → consumer → executor → HTTP result, with idempotency, isolation, deadline/permission/transport failures, private mount inspection and secret-free output checks. Separate tests use real loopback HTTP to prove redirect refusal, partial-response retry and stalled-body cancellation. See [review 0021](../quality/reviews/0021-ticket-cli.md) for actual results and limits.
