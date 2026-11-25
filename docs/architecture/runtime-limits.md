# Runtime limits and future AI budgets

Status: work/ownership and HTTP limits below describe the committed local implementation; AI/tool budgets remain proposed until those adapters exist. These are finite policy bounds, not measured performance targets.

## Work and ownership

| Setting | Initial value | Rationale |
| --- | --- | --- |
| Execution attempt lease | 30 seconds | Recovery remains observable in a local scenario |
| Heartbeat interval | 5 seconds | Allows several renewal opportunities within a lease |
| Attempt deadline | 60 seconds | Finite execution despite successful lease renewals |
| Attempts per generation | 3 total, including first claim and crashed attempts | Bounds repeated external work |
| Executor concurrency | 2 jobs per process | Keeps contention demonstrable without saturating a laptop |
| Retry delay | Full jitter from 0 to min(10 s, 1 s * 2^(attempt-1)) | Avoids synchronized retries; finite cap |
| Outbox batch | At most 20 records | Bounded claims and publication work |
| Outbox publication lease | 30 seconds | Expired claims can recover |
| Producer operation timeout | 10 seconds | Below the publication lease |
| Work/outbox polling | 500 milliseconds when idle, with jitter | Responsive demo without busy loops |
| Graceful shutdown | At most 15 seconds | Stop claims, drain bounded work, then rely on leases |

Heartbeat frequency must be less than one third of the lease; reject configurations violating this safety margin. Ownership is checked using database time. Attempt deadlines use a monotonic local clock; they do not replace database fencing. In-flight external calls may outlive cancellation, so persistence remains conditional.

On shutdown, stop readiness and new claims first. Finish only work that fits the remaining drain budget; otherwise abort external requests best-effort and leave committed jobs recoverable by lease expiry. Never mark an abandoned job completed. A broker outage does not mark outbox rows permanently failed.

## AI budgets

| Limit per attempt | Initial value |
| --- | --- |
| Model turns | 4 |
| Tool calls | 3 total, executed serially |
| Tool deadline | 3 seconds, also bounded by remaining attempt time |
| Model request deadline | 15 seconds, also bounded by remaining attempt time |
| Retrieved chunks | 5 |
| One chunk content | 2 KiB UTF-8 |
| Total retrieved context | 10 KiB UTF-8 |
| One tool result | 8 KiB UTF-8 |
| Generated answer | 8 KiB UTF-8 |
| Final execution summary | 4 KiB UTF-8 |
| Real generation output | At most 1,024 output tokens per model turn |

Stop before a call if no budget remains. Never silently truncate structured arguments or IDs into a different valid request. Oversized tool/model output is rejected as a safe execution failure; citation IDs must still be validated. Provider token limits are adapter-specific and require compatibility tests. Byte limits do not establish an exact dollar ceiling; live cost reports use provider usage when available and flag missing usage.

Retry only safe classified transient dependency errors: timeouts, temporary connectivity failures, rate limits, and selected provider server errors. Validation failures, forbidden tools, incompatible model output, exhausted budgets, and invalid credentials are terminal for that generation. Provider Retry-After may defer the durable job within a maximum 30-second delay; it must not create an unbounded sleep or bypass the attempt limit. No nested SDK retries: the executor owns model/tool retry scheduling.

## HTTP and local operations

Authenticated requests: at most 120 requests per principal per minute. Submission: additionally 10 per tenant per minute. Replay shares the submission tenant budget of 10 per minute, as accepted in the committed replay batch; the earlier separate 3/minute proposal is not implemented. Use atomic limiter operations and define testable window boundaries; initial policy uses fixed UTC minute windows, so boundary bursts are a documented limitation.

Unauthenticated ingress: 300 requests per source address per minute using only the actual peer address; do not trust forwarded headers by default. A Redis outage rejects affected business routes with 503. Health probes are separate and disclose no secrets. Local users can control container networking, so ingress limits are abuse controls, not host isolation.

CLI default deadline is 60 seconds with one-second status polling. Host scenarios report separate finite per-operation/startup/checkpoint bounds; they can wait for the real 30-second lease. A deadline expiring does not cancel durable work or produce a passing scenario.

These values are design defaults. Exact environment variable names and memory/CPU allocation are defined with the approved Compose patch. Benchmark minimum hardware and cold-start time before publishing prerequisites; no measured resource requirement exists yet.
