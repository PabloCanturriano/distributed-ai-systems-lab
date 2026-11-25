# CLI contract and reviewer journey

Status: `demo`, `ticket create/get/wait`, identity selection, deadlines and JSON output are committed; see [review 0021](../quality/reviews/0021-ticket-cli.md). `ticket replay` with explicit generation/key and operator authorization is committed in [review 0022](../quality/reviews/0022-ticket-replay-batch.md). The phase-3 working tree adds an API duplicate scenario, a scenario catalog and a fixed host runner; evaluation remains proposed. No released environment is claimed.

## First-run journey

The implemented startup uses both `messaging` and `execution` profiles, followed by an explicitly built, on-demand CLI. See the [verified local commands](../operations/ticket-cli.md). The original target of a default-profile full workflow remains future work. The guide builds the CLI, starts infrastructure with migrations/seeds and then demonstrates a ticket from submission to its simulated result. A reviewer needs Git and Docker Compose, not a local Node.js installation or an AI API key.

The CLI prints the selected fictional tenant/role alias, simulated or real mode, ticket ID, progress, answer/abstention, citations, tool names, and trace lookup hints as documented in the [phase-2 trace guide](../operations/trace-correlation.md). No viewer URL is generated. It never displays bearer credentials, prompts, or raw tool payloads. It distinguishes scenario failure from unavailable infrastructure and polling deadline expiry.

## Command contract (partially implemented)

All business commands call the API. Names below are CLI arguments after `docker compose run --rm cli`:

| Command | Behavior |
| --- | --- |
| `demo` | Submit a fixed fictional question, poll, and explain the resulting evidence |
| `ticket create --message <text> [--key <key>]` | Generate a key once if omitted; submit and print the acceptance receipt |
| `ticket get <ticket-id>` | Show current generation and sanitized result/failure |
| `ticket wait <ticket-id> [--deadline <seconds>]` | Poll until terminal state or deadline |
| `ticket replay <ticket-id> --generation <n> --key <key>` | Submit authorized replay; require explicit target generation and stable retry key |
| `scenario list` | List API-only checks and host-orchestrated checks separately |
| `scenario run <name>` | Execute an API-only workflow or evaluate host-prepared recovery evidence |
| `evaluate --suite workflow` | Evaluate black-box scripted ticket behavior over HTTP; does not run internal retrieval benchmarks |

Implemented global options: `--identity <alias>`, `--json`, `--no-color`, `--deadline <seconds>`, and `--help`. This slice fixes the endpoint to `http://api:3000` on the trusted Compose backend; no remote endpoint option is implemented. The CLI does not forward credentials across redirects. Secret tokens are read from the dedicated local volume, never passed as CLI arguments.

JSON output is one final object on stdout; progress goes to stderr. The object includes schema version, command, outcome, request/ticket/generation IDs where available, elapsed time, and safe error details. Color and progress animations are disabled in non-interactive output. Errors and assertion failures never print a success banner.

Exit codes: `0` successful command/assertions, `1` completed command with failed scenario assertions, `2` invalid arguments, `3` authentication/authorization failure, `4` dependency or transport failure, and `5` polling deadline exceeded. Invalid IDs and HTTP contract errors include their safe API code rather than being disguised as timeouts.

## Safe client retries

Generate and retain the submission key before the first HTTP attempt. Retry transient transport/503 failures at most twice within the same overall deadline using the same key and validated payload. Honor bounded Retry-After. Never automatically replay a failed ticket or retry a conflicting request with a different key. A CLI process that exits prints the non-secret key with its receipt/error so the reviewer can retry deliberately.

A `202` receipt is not a completed ticket. `ticket create` can exit successfully on acceptance, while `demo` and `ticket wait` require the requested terminal outcome. Readiness checks and polling failures cannot manufacture completion.

## Infrastructure scenarios

An application container never mounts the Docker socket. Host-level Compose orchestration is separate from the CLI and runs under the human operator's authority. The scenario runner is a fixed allowlisted repository tool, not an arbitrary shell-command endpoint or an agent tool. Its implementation is included in the phase-3 patch review.

The implemented host interface is `node scripts/scenarios.mjs list` and `node scripts/scenarios.mjs run <name>`. Fixed names are `delivery-repair`, `crash-after-response`, `crash-after-publication`, `crash-after-scheduling` and `collector-outage`. Each invokes one repository harness without a shell, observes its required checkpoint marker and requires a successful complete harness before returning a single passed JSON result. Diagnostics go to stderr. Unknown names or extra arguments are rejected. Individual startup/operation/checkpoint waits are bounded by each harness.

`cli scenario list` distinguishes API and host entries. `cli scenario run duplicate-submission` uses the same key for two ordinary authenticated API acceptances and asserts equal receipts; it makes no infrastructure recovery claim. All host entries return nonzero `HOST_REQUIRED` in the business CLI without reading credentials or making an API request. The business image cannot read an evidence file or declare a host crash passed from a normal HTTP result. Test-only crash actors are injected by the host harness, absent from image build inputs and business HTTP routes.

API-only scenarios include duplicate HTTP submissions, authorization checks, and expected-generation replay. Crash-after-publication, consumer restart, Kafka outage, Redis outage, and stale-attempt checks require host preparation or the integration harness. The CLI must not claim that an API-only request proves these infrastructure failures.

## Reviewer evidence

Every scenario has an ID, prerequisites, fixture version, bounded steps, expected assertions, observed outcomes, and cleanup behavior. Output includes a trace ID or query hints where supported. Recovery scenarios preserve relevant ticket/history evidence; destructive reset is a separate explicit action.

The reviewer guide is the implemented form of this contract: one short happy path, one duplicate check, one recovery example, and links to deeper evidence. No frontend is built. OpenAPI, Jaeger, and Prometheus are inspection tools, not a custom product interface.

## Acceptance additions

- CLI-01: a clean Docker-only journey succeeds without external credentials.
- CLI-02: generated retry keys remain stable across transient HTTP retries.
- CLI-03: JSON output parses as one object; diagnostics do not corrupt stdout.
- CLI-04: timeout, assertion failure, and transport failure have distinct nonzero exits.
- CLI-05: a non-operator cannot replay and changing identity cannot select another tenant implicitly.
- CLI-06: crash scenarios cannot report passed without observing their required host-side checkpoint.

Retrieval and real-provider quality evaluations run through the dedicated evaluation harness, not through direct database access inside this CLI.
