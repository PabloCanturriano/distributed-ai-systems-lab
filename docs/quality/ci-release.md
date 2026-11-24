# CI, release, and deployment plan

Status: the committed foundation workflow passed for `2f69c99` ([hosted run](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45478107145)), including CLI execution on x64 and ARM64. The replay gate is prepared for batch review and has local evidence only. Registry publishing, release, hosted deployment and the complete acceptance pipeline remain planned.

## Foundation workflow

`.github/workflows/foundation.yml` runs on pull requests, pushes to main and manual dispatch. It uses fixed action revisions, Node 24.22.3, read-only repository permissions, disabled checkout credential persistence, disabled package caching and finite job deadlines. It receives no provider/registry secrets and performs no publication or deployment.

The checks job runs formatting, type/build and fast tests. The integration job runs PostgreSQL, application-image, Compose, native Kafka-tool, relay and consumer suites sequentially on Ubuntu 24.04 x64. A separate Ubuntu 24.04 ARM64 job runs the isolated client evaluation, relay and consumer suites with their pinned native artifacts. The executor gate runs after the consumer gate on both architectures, with job deadlines of 40 minutes (x64) and 30 minutes (ARM64). It uses Node built-ins on the host and image-built application code. See [review 0020](reviews/0020-automatic-executor.md) for scope and limitations. The committed CLI gate follows the executor gate on both architectures; [review 0021](reviews/0021-ticket-cli.md) records its scope. The proposed replay batch adds `npm run test:replay` after the CLI gate on both architectures; [review 0022](reviews/0022-ticket-replay-batch.md) records local evidence. The new replay gate has not run in hosted CI.

The final `Foundation gate` requires every preceding job to succeed, including when another job fails or is skipped. Repository branch protection is not configured by this patch. No logs, credential volumes or snapshots are uploaded as artifacts. Remaining security, AI, scan and release gates below are not represented as passing by this foundation workflow.

Validation: `actionlint` 1.7.12 reported no errors for the changed workflow. Local formatting, type/build, unit, PostgreSQL, executor and default Compose checks passed for that baseline; the replay batch records its validation in review 0022. Hosted baseline success does not establish hosted success for this uncommitted patch.

## Pull requests

Run formatting, lint, type checks, unit/contract tests, PostgreSQL/Kafka integration, migrations, deterministic security/AI assertions, and a Docker smoke journey on a clean environment. Reuse build artifacts where safe, but never skip an affected correctness gate merely because a cache hit occurred.

Untrusted pull requests receive no provider/registry secrets, write tokens, or privileged deployment credentials. Do not use privileged target-context workflows to execute untrusted branch code. Use minimal workflow permissions, pinned third-party action revisions, lockfile installs, bounded job timeouts, and scoped artifact retention.

The workflow shows actual selected checks and failures. A missing Docker runtime or skipped required scenario fails the corresponding gate. Upload only sanitized logs/reports; do not export credential volumes, private prompts, environment dumps, or database snapshots as default artifacts.

## Trusted branch and release

A trusted main-branch job runs the full recovery/Compose suite and dependency/image/secret scans. Document findings and triage; never suppress a vulnerability without a reason, scope, and review date. Changes to migration/schema compatibility require both clean-install and previous-release upgrade checks.

Versioned releases are explicit owner-authorized actions. A release pipeline builds API/worker and CLI images, records revision/digests, runs the same Docker-only journey, and publishes an artifact manifest plus software/dependency inventory and sanitized evaluation evidence. Do not tag untested images as a release or overwrite a version with different content.

Registry publication uses a trusted release identity, not a developer's committed token. Immutable revision tags and pinned manifest digests support reproducibility. Runtime packages and container bases are scanned separately. Release evidence includes supported OS/architecture, resource measurements, startup time, migration boundary, known limitations, and offline versus real-provider evaluation status.

## AI jobs

Deterministic scripted tests and offline retrieval evaluation run without external secrets. Real-provider evaluations are manually authorized trusted jobs with model/profile identifiers, finite budgets, explicit data policy, and no secret access from forks. Reports cannot silently mix lexical, semantic, simulated, and live results.

## Delivery boundary

CI and release publication are in scope. Automatic deployment to a hosted environment is not: it requires a destination, identity/network/security decisions, migration strategy, rollback/restore plan, and separate approval. Do not label image publication alone as continuous deployment.

Before a public working release, the owner also chooses the repository license and vulnerability-reporting channel. This documentation does not select a license or invent a private contact address.

## Release acceptance

A release is eligible only when all required acceptance families are accounted for, required checks pass, the README journey works from a clean clone, and limitations match actual evidence. Run the image-built-from-source path and the published-image path if both are advertised. A previous successful run is not proof for a changed revision.

No release status is claimed by committing this plan.
