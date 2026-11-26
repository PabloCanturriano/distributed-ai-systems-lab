# Phase 6: reviewer-ready release preparation

Status: in progress. Phase-five source is published through `c3b304c` as nine coherent commits, with the exact approved final tree unchanged. Its [local acceptance](phase5.md) passed seventeen controls and 59 criteria. The first hosted ARM64 run failed the new host workflow build due to missing installed Node types; [CI-ARM-01](ci-release.md) has a minimal candidate correction. New phase-six code/configuration remains pending exact-patch review. No release has been published.

## Current slice

- A targeted migration-dependency override, verified by a fresh install, consistent dependency tree, production audit and all 215 real PostgreSQL cases.
- Exportable OpenAPI for the five explicit implemented HTTP operations. Twenty contract tests exercise actual loopback HTTP responses, health states, receipts, lifecycle/results, safe errors, headers, local references and rejected extra authority. No public documentation endpoint or SDK is added.
- An isolated Docker-only reviewer journey, a tested source snapshot helper that preserves the owner's Git index, and sanitized startup/resource observations. It checks both tenant demos, stable duplicate receipts and queued-work recovery.
- Candidate CI steps for production advisories, OpenAPI export and the reviewer journey on x64 and native ARM64. The current hosted run validates published phase five, not these uncommitted additions.

The OpenAPI artifact is produced by `npm run export:openapi` at `artifacts/openapi-v1.json`. It uses [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html) and the existing Zod dependency's [JSON Schema conversion](https://zod.dev/json-schema). JSON Schema descriptions call out UTF-8 byte, trimming, ownership and cross-field constraints that conversion cannot fully express; tests do not claim an independent full OpenAPI metaschema audit.

## Release readiness

| Item                                                                                 | State and evidence                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline application and migration behavior                                           | Published phase-five tree; 345 fast and 215 SQL cases, seventeen local controls                                                                                                 |
| New HTTP contract and snapshot behavior                                              | 366 fast cases across 27 suites with this candidate                                                                                                                             |
| Production dependency advisories                                                     | Candidate audit: zero findings; [triage and scope](../release/dependency-triage.md) retain the initial three moderate entries                                                   |
| Reviewer journey and measured observations                                           | [Commands and measurement scope](../release/reviewer-quickstart.md); candidate passed all three reviewer checks with four resource samples and scoped cleanup                   |
| CI-ARM-01                                                                            | Published ARM64 job lacks host dependency installation before its final workspace build; isolated fix prepared, new hosted validation pending                                   |
| OBS-CLI-01                                                                           | Initial collector-outage CLI exit 4 remains unclassified; mandatory scenario retained. See [investigation](reviews/0026-bounded-offline-agent.md#investigation-note-obs-cli-01) |
| License and private reporting channel                                                | Owner explicitly left both undecided for analysis; [options](../release/policy-options.md). No license/contact/setting selected                                                 |
| OS/image and secret scans, image/license inventories                                 | Source npm inventory generated (156 components); OS/image scans, secret scanning and full image/license-notice review remain pending                                            |
| Registry destination, release identity, immutable manifests and publication workflow | Pending concrete owner-reviewed choices and implementation                                                                                                                      |
| Public working release                                                               | Pending the remaining gates and explicit owner authorization                                                                                                                    |

## Commit size

Keep each candidate commit focused on a reviewable behavior with its tests: dependency fix; HTTP contract/export; source snapshot/reviewer journey; CI checks; documentation. Shared package scripts can be staged by purpose. The phase-five integration patch was similarly repartitioned without changing its approved contents; intermediate trees passed their appropriate checks before publication.

This document is a readiness record, not an approval to publish images, change repository visibility, configure a private reporting channel or deploy a service.

## Candidate verification record

- `npm run check`: 366 fast tests in 27 suites, plus formatting, types and builds, passed.
- All six PostgreSQL suites: 215 tests passed against the patched migration dependency.
- Fresh install and `npm ls --all`: consistent graph; production audit changed from three moderate entries to zero findings. This excludes development-only and OS/image findings.
- OpenAPI host/image exports: byte-identical five-operation output; artifact SHA256 `a115367c0fc1804a7416bba3fb27a4cd9e1b2c571fe691414fd0d9f24497eef8`.
- Reviewer candidate journey: both cited tenant demos, duplicate receipt and stopped-executor recovery passed with cleanup, bound to the report's implementation digest.
- CI-ARM-01 candidate: fresh lockfile install and the twelve-case workflow evaluation passed in an isolated Git checkout of published phase-five source. Actual hosted validation awaits commit/push.
- `actionlint` 1.7.12 passed the candidate workflow. No release or settings were published.

A production-source inventory was also generated with `npm sbom --omit=dev --sbom-format cyclonedx`: `artifacts/source-sbom.cdx.json` contains 156 components in the tool's CycloneDX 1.5 output. It inventories npm source dependencies, not OS packages or final-image contents, and does not select a license for the owner's code. Full license/notice and image inventories remain pending.
