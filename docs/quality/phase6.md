# Phase 6: reviewer-ready release preparation

Status: in progress. Published source `e21d17fd7c876c69a5d0d4d49ce4b71782a2570c` passed [all four hosted jobs](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45861860217), including x64 and native ARM64. The repository is public, private vulnerability reporting is enabled, and the `release` environment requires owner review from `main`. No release has been published. See [the current gate follow-up](reviews/0029-filtered-runtime-and-release-gates.md).

## Current slice

- A targeted migration-dependency override, verified by a fresh install, consistent dependency tree, production audit and all 215 real PostgreSQL cases.
- Exportable OpenAPI for the five explicit implemented HTTP operations. Twenty contract tests exercise actual loopback HTTP responses, health states, receipts, lifecycle/results, safe errors, headers, local references and rejected extra authority. No public documentation endpoint or SDK is added.
- An isolated Docker-only reviewer journey, a tested source snapshot helper that preserves the owner's Git index, and sanitized startup/resource observations. It checks both tenant demos, stable duplicate receipts and queued-work recovery.
- Published CI steps for production advisories, OpenAPI export and the reviewer journey on x64 and native ARM64, verified by the hosted run above.

The OpenAPI artifact is produced by `npm run export:openapi` at `artifacts/openapi-v1.json`. It uses [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html) and the existing Zod dependency's [JSON Schema conversion](https://zod.dev/json-schema). JSON Schema descriptions call out UTF-8 byte, trimming, ownership and cross-field constraints that conversion cannot fully express; tests do not claim an independent full OpenAPI metaschema audit.

## Release readiness

| Item                                                                                 | State and evidence                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline application and migration behavior                                           | Published phase-five tree; 345 fast and 215 SQL cases, seventeen local controls                                                                                                                                                              |
| New HTTP contract and snapshot behavior                                              | 366 fast cases across 27 suites in the approved phase-six slice                                                                                                                                                                              |
| Production dependency advisories                                                     | Approved slice audit: zero findings; [triage and scope](../release/dependency-triage.md) retain the initial three moderate entries                                                                                                           |
| Reviewer journey and measured observations                                           | [Commands and measurement scope](../release/reviewer-quickstart.md); approved slice passed all three reviewer checks with four resource samples and scoped cleanup                                                                           |
| CI-ARM-01                                                                            | Resolved: `f0a3315` installs host dependencies; the subsequent hosted ARM64 job passed                                                                                                                                                       |
| OBS-CLI-01                                                                           | Resolved in published source: bounded isolated lookup and permanent cold-DNS scenario passed locally and hosted on both architectures. Historical attribution remains limited; [follow-up](reviews/0028-release-policy-and-dns-isolation.md) |
| License and private reporting channel                                                | Apache-2.0 is published; GitHub private reporting is enabled on the public repository; [policy](../release/policy-options.md). release environment requires owner review                                                                     |
| OS/image and secret scans, image/license inventories                                 | Scanned 18 ARM64 images and Git/source secrets; [findings and candidate fix](../release/security-inventory.md). Base-image triage and full license/NOTICE review remain open                                                                 |
| Registry destination, release identity, immutable manifests and publication workflow | GitHub Releases/GHCR and `v0.1.0-rc.1` selected; [pipeline prepared for review](../release/publication.md), no publication executed                                                                                                          |
| Public working release                                                               | Pending remaining security/native gates and exact artifact review                                                                                                                                                                            |

## Commit size

Keep each candidate commit focused on a reviewable behavior with its tests: dependency fix; HTTP contract/export; source snapshot/reviewer journey; CI checks; documentation. Shared package scripts can be staged by purpose. The phase-five integration patch was similarly repartitioned without changing its approved contents; intermediate trees passed their appropriate checks before publication.

This document is a readiness record, not an approval to publish images, change repository visibility, configure a private reporting channel or deploy a service.

## Approved slice verification record

- `npm run check`: 366 fast tests in 27 suites, plus formatting, types and builds, passed.
- All six PostgreSQL suites: 215 tests passed against the patched migration dependency.
- Fresh install and `npm ls --all`: consistent graph; production audit changed from three moderate entries to zero findings. This excludes development-only and OS/image findings.
- OpenAPI host/image exports: byte-identical five-operation output; artifact SHA256 `a115367c0fc1804a7416bba3fb27a4cd9e1b2c571fe691414fd0d9f24497eef8`.
- Reviewer candidate journey: both cited tenant demos, duplicate receipt and stopped-executor recovery passed with cleanup, bound to the report's implementation digest.
- CI-ARM-01: fresh lockfile install and the twelve-case workflow evaluation passed in an isolated Git checkout; the published correction also passed hosted ARM64 CI.
- `actionlint` 1.7.12 passed the candidate workflow. No release or settings were published.

A production-source inventory was also generated with `npm sbom --omit=dev --sbom-format cyclonedx`: `artifacts/source-sbom.cdx.json` contains 156 components in the tool's CycloneDX 1.5 output. It inventories npm source dependencies, not OS packages or final-image contents, and does not select a license for the owner's code. Full license/notice and image inventories remain pending.

## Release-policy follow-up

The owner accepted the release recommendations on 2026-11-26 and requested focused commits plus real Docker checks. Runtime-tool removal is committed locally as `557b471`; subsequent implementation patches remain pending exact-patch approval. The selected source license and metadata are prepared separately from notice export, service-image refreshes and publication tooling.

The prepared notice exporter inventories all eight application roles, preserves Node/Debian/npm/native notices and records Debian source-package versions. Its real-image run reports no missing package license texts after capturing embedded README notices and two explicitly sourced supplements. This completes that inventory pass, not the final static-component/source-availability review. See [third-party notices](../../THIRD_PARTY_NOTICES.md).

Redis's same-version image rebuild reduces raw records from 239 to 209 on both scanned architectures. Collector 0.166.0 reports zero findings in the same vulnerability-database snapshot on AMD64 and ARM64. These are candidate-image observations, not claims that the full stack is clear. The remaining Node-based image gates still block high/critical OS records.

The ten fresh-volume OBS-CLI-01 baseline runs produced eight passes and two failures. A temporary instrumented snapshot also reproduced PostgreSQL connection acquisition timeouts during an API read while all four execution jobs were already completed. A cold internal collector alias reproduced the failure with stalled PostgreSQL DNS before TCP. The prepared fix isolates collector DNS from libuv's shared getaddrinfo pool, with two pending resolutions and a 350 ms deadline, preserving PostgreSQL/CLI limits. Three equivalent cold-alias runs and the strengthened permanent scenario passed. The exact patch and hosted validation remain pending; the initial historical failure cannot be attributed retrospectively with certainty.

Final candidate verification passed all seventeen application controls and 59 criteria, including 373 fast cases in 30 suites, 215 real PostgreSQL cases in six suites and the permanent cold-DNS collector scenario. Twelve scripted workflow cases passed; offline Recall@5 remains 0.95 with the same two recorded misses. The final source-built reviewer journey passed all three checks with cleanup. The rebuilt eight-role image inventory and CycloneDX output remain blocked by OS findings; the original Node-layer inventory also retains four unresolved notice-text records. These are local candidate results, not a public release or new hosted-CI claim.
