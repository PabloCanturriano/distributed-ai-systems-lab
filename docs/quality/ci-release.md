# CI, release, and deployment plan

Status: planned. No workflow, registry publishing, release, or hosted deployment is configured.

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
