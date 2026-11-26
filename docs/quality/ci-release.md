# CI and release boundary

Status: phase-five source is published through `c3b304c`. Its local seventeen-control gate passed, but the [first hosted run](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45728624070) failed the final ARM64 host workflow build because that job did not install host dependencies. The candidate fix below is prepared for review, not represented as deployed or green. No registry publication, release or hosted deployment exists.

## Published checks

The foundation workflow runs on pull requests, main pushes and manual dispatch with pinned actions and Node 24.22.3, read-only permissions, disabled checkout credential persistence, no package caching and finite job deadlines. It receives no model/registry secrets and performs no publication.

The checks job installs the lockfile and runs formatting, type/build and fast tests. The x64 integration job installs host dependencies and runs PostgreSQL, application-image, Compose, Kafka, relay, consumer, executor, CLI, replay, tracing, delivery repair, response-crash, collector-outage, retrieval, RAG and scripted workflow checks. The native ARM64 job runs the isolated client plus the corresponding Docker-driven integration journeys.

The final `Foundation gate` requires every preceding job to succeed. A failed or skipped required job cannot count as success. Branch protection and publication identities are not configured by this workflow.

## Candidate ARM host setup correction: CI-ARM-01

The ARM job originally needed only Node built-ins to drive Docker. The new `evaluate:workflow` command also runs a workspace TypeScript build on the host. Its job lacked `npm ci`; the published failure reports TS2688, missing the Node type definitions. Earlier ARM Docker checks completed successfully. This is a host setup failure, not a reported runtime tool/ownership failure.

A minimal separate patch adds the same lockfile install, with scripts/audit/funding disabled, immediately before that host evaluation. The actual checkout remains necessary because evaluation records Git/source identities. An isolated checkout of the exact published phase-five tree verifies the fresh install plus workflow build/evaluation. New hosted success requires owner approval, commit and push; it is not inferred from local validation.

## Candidate phase-six checks

Separate candidate changes add OpenAPI export and `npm audit --omit=dev --audit-level=moderate` to the checks job, plus `test:quickstart` after scripted evaluation on x64 and ARM64. Every existing control remains. An advisory-service failure or a moderate-or-higher production finding fails the audit step; no finding is silently ignored. The [dependency triage](../release/dependency-triage.md) records scope and the current targeted fix.

The quickstart driver uses built-ins, Git and Docker to archive candidate source without host packages/build outputs, start fresh isolated volumes, exercise ordinary business HTTP via the CLI and collect sanitized measurements. It deletes only its own Compose project. Read [measurement limits](../release/reviewer-quickstart.md) before interpreting startup/resource samples.

## Remaining release work

[Phase-six readiness](phase6.md) records all outstanding items. Required before a working public release: classify OBS-CLI-01, complete image/secret scans and dependency/license inventories, select the maintained private reporting channel and repository license, define registry destination/release identity, produce immutable image digests and sanitized release manifests, and prove the advertised source-built and published-image paths.

Publication is an explicit owner-authorized action. Untrusted branch code must not receive write tokens, registry secrets or model credentials; do not execute it through privileged target-context workflows. Any future pipeline must keep pinned inputs, minimal permissions, bounded jobs and scoped artifact retention. Upload no credential volumes, environment dumps, private prompts, database snapshots or raw sensitive logs.

Real-model evaluation remains a separately authorized trusted feature with provider/model/profile identifiers, fictional data policy, finite budgets and distinct quality/usage reports. Passing scripted workflows or lexical recall cannot satisfy it.

Hosted deployment requires its own destination, identity/network/migration/rollback decisions and approval. Image publication alone is not a deployment. No release tag, registry target, private contact address or response SLA is invented by this preparation.
