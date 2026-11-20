# CI, release, and deployment plan

Status: the foundation-check workflow is committed; the real relay gate additions are prepared for review. Hosted execution has not been verified. Registry publishing, release, hosted deployment and the complete acceptance pipeline remain planned.

## Prepared foundation workflow

`.github/workflows/foundation.yml` runs on pull requests, pushes to main and manual dispatch. It uses fixed action revisions, Node 24.22.3, read-only repository permissions, disabled checkout credential persistence, disabled package caching and finite job deadlines. It receives no provider/registry secrets and performs no publication or deployment. The [official runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) distinguish x64 and ARM64 execution.

The checks job runs the existing formatting, type/build and unit tests. The integration job runs the PostgreSQL, application-image, Compose, native Kafka-tool and real relay suites sequentially on Ubuntu 24.04 x64. A separate Ubuntu 24.04 ARM64 job runs the [isolated client evaluation](reviews/0010-kafka-client-compatibility.md), whose experimental native artifact is ARM64-only, followed by the application relay suite using its separately verified ARM64 artifact. The relay gate also runs on x64; hosted execution of these additions remains unverified. The host client runner needs only Node built-ins; its Docker build installs the experimental lockfile with lifecycle hooks disabled.

The final `Foundation gate` requires every preceding job to succeed, including when another job fails or is skipped. Repository branch protection is not configured by this patch. No logs, credential volumes or snapshots are uploaded as artifacts. The remaining business, security, AI, lint and release gates below are not implemented or represented as passing by this foundation workflow.

Validation: `actionlint` 1.7.12 reported no errors for the workflow; Prettier, relative documentation links and whitespace checks passed locally. The underlying commands have local execution evidence in reviews 0008/0010 and the relay additions in [review 0015](reviews/0015-local-kafka-relay.md); Linux x64 hosted execution and the GitHub workflow itself remain unverified until an authorized push and completed run. This patch does not claim a green GitHub check.

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
