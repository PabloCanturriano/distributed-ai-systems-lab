# CLI contract and reviewer journey

Status: proposed interface; none of the commands below are executable yet. The final README will contain only commands verified against a released Compose environment.

## First-run journey

The target startup is `docker compose up --build -d --wait`, followed by `docker compose run --rm cli demo`. The first command starts infrastructure, completes migrations and fictional seeds, and waits for the required services. The second demonstrates a ticket from submission to answer. A reviewer needs Git and Docker Compose, not a local Node.js installation or an AI API key.

The CLI prints the selected fictional tenant/role alias, simulated or real mode, ticket ID, progress, answer/abstention, citations, tool names, and trace lookup information. It never displays bearer credentials, prompts, or raw tool payloads. It distinguishes scenario failure from unavailable infrastructure and polling deadline expiry.

## Proposed commands

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

Global options: `--identity <alias>`, `--json`, `--no-color`, `--deadline <seconds>`, and `--help`. Endpoint selection is explicit and follows the security policy; the CLI does not forward credentials across redirects. Secret tokens are read from the dedicated local volume, never passed as CLI arguments.

JSON output is one final object on stdout; progress goes to stderr. The object includes schema version, command, outcome, request/ticket/generation IDs where available, elapsed time, and safe error details. Color and progress animations are disabled in non-interactive output. Errors and assertion failures never print a success banner.

Exit codes: `0` successful command/assertions, `1` completed command with failed scenario assertions, `2` invalid arguments, `3` authentication/authorization failure, `4` dependency or transport failure, and `5` polling deadline exceeded. Invalid IDs and HTTP contract errors include their safe API code rather than being disguised as timeouts.

## Safe client retries

Generate and retain the submission key before the first HTTP attempt. Retry transient transport/503 failures at most twice within the same overall deadline using the same key and validated payload. Honor bounded Retry-After. Never automatically replay a failed ticket or retry a conflicting request with a different key. A CLI process that exits prints the non-secret key with its receipt/error so the reviewer can retry deliberately.

A `202` receipt is not a completed ticket. `ticket create` can exit successfully on acceptance, while `demo` and `ticket wait` require the requested terminal outcome. Readiness checks and polling failures cannot manufacture completion.

## Infrastructure scenarios

An application container never mounts the Docker socket. Host-level Compose orchestration is separate from the CLI and runs under the human operator's authority. The scenario runner is a fixed allowlisted repository tool, not an arbitrary shell-command endpoint or an agent tool. Its implementation requires owner approval.

Proposed host invocation is `docker compose --profile scenarios run --rm scenario-check` only if it does not need Docker access; otherwise the reviewed host runner invokes fixed Compose actions directly. Do not publish an executable command until that interface is implemented and tested. Fault checkpoints are local-only startup options, disabled by default and absent from business HTTP routes.

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
