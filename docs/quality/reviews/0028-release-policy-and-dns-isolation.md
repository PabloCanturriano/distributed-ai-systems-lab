# Review 0028: release policy and collector DNS isolation

Status: implementation prepared for exact-patch review. The owner accepted the release recommendations and requested separate commits plus real Docker verification. Only the already reviewed runtime-tool removal is committed locally as `557b471`; no new release, registry publication or repository visibility/reporting setting has been changed.

## Focused implementation sequence

| Proposed commit                                                  | Purpose and files                                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fix: refresh the pinned Redis base layers`                      | Same Redis 8.10.3 version, new image digest in Compose; 239 raw findings become 209 on both scanned architectures                                                          |
| `fix: migrate and refresh the telemetry collector`               | Collector 0.166.0 pin and its required `resource_constant_labels` migration; only four bounded resource attributes are included                                            |
| `fix: isolate collector DNS from business connections`           | Scoped IPv4 resolver for the fixed collector, three regression cases, and a permanent fresh-alias outage fixture                                                           |
| `chore: license project source under Apache-2.0`                 | Canonical license, project notice, workspace/lockfile license metadata, reviewer guidance and runtime license inclusion/assertions; dependency versions unchanged          |
| `feat: export per-image third-party notice bundles`              | Exact-byte/hash export from read-only network-disabled containers, nested/native notices, Debian source versions and explicitly sourced supplements                        |
| `feat: validate release identities and published-image journeys` | Version/source/image/role/platform validation and an immutable-image mode for the real reviewer journey                                                                    |
| `ci: prepare guarded multi-platform evaluation releases`         | Manual read-only preparation, bounded artifacts, strict security/notice gates, separated package/release permissions, anonymous native journeys and protected finalization |

## OBS-CLI-01 evidence and scope

Ten fresh-volume runs of committed source `557b471` produced eight passes and two CLI exit-4 failures. All four execution jobs were completed; API, relay, consumer and executor remained running without OOM. A temporary instrumented copy reproduced the failure as PostgreSQL connection-open timeouts, rather than a checkout queue waiting for a free client.

A new internal DNS alias for the same collector reproduced the failure again. At the final error the pool had started fourteen connections, only ten DNS lookups and ten TCP connections had completed, and four new connections had timed out. There were no waiting pool borrowers. Expected negative ticket reads were separate from this connection failure. No credentials, request/results, SQL text or raw exceptions were added to the diagnostic output.

Node documents that [`dns.lookup` uses getaddrinfo on the shared libuv worker pool, while resolve APIs do not](https://nodejs.org/docs/latest-v24.x/api/dns.html#implementation-considerations). The controlled reproduction and counterfactual fix support resolver starvation for this reproduced signature. They do not establish the root cause of the original historical run whose detailed diagnostics were discarded.

The proposed resolver uses c-ares for the fixed collector only, on the existing IPv4 Docker backend. It permits two concurrent lookups, caps returned addresses, cancels after 350 ms and safely ignores late callbacks. It does not change global DNS, nameservers, business destinations, PostgreSQL deadlines, CLI retries or scenario assertions. Its local resolver does not use `/etc/hosts`; the accepted Compose deployment uses service DNS. IPv6/other deployment discovery remains outside this slice.

Actual regression evidence:

- The new resolver tests initially failed because the implementation/export was absent; all three then passed, including missing-address errors and cancellation/late-callback handling.
- A real UDP DNS fixture resolves the collector while a single shared libuv worker is occupied by bounded crypto work and an ordinary DNS lookup remains queued. No timing sleep is used as a correctness checkpoint.
- Three cold-alias counterfactual runs passed with the fix. The permanent scenario now uses a fresh internal alias through a test-only read-only preload, asserts that it was exercised and retains every business, Jaeger, Prometheus, disclosure and recovery assertion. The production image/application destination remains fixed and unchanged.
- Fifteen additional minimally instrumented baseline runs happened to pass. They are retained as observations, not relabeled as a causal fix or a statistical reliability guarantee.

## Other actual checks

- The existing collector config failed validation on 0.166.0 because resource-to-telemetry conversion was disabled. The documented replacement with four explicit constant resource labels validates and the real upgraded collector scenario passes. No deprecated feature is re-enabled to mask the change.
- API/worker image startup, isolation, license/tool absence assertions and shutdown passed. The three source-built reviewer checks passed with scoped cleanup.
- All eight application roles were rebuilt, scanned and inventoried after the DNS change, with role-specific CycloneDX output and immutable image identities in `artifacts/release-final-2026-11-26/`. Each still has 250 raw OS records (one critical, 38 high); its gate remains blocked. No missing package notice text was detected in those merged-image inventories.
- All eight merged-image notice inventories reported zero missing package texts, including README-embedded notices and the two sourced supplements. The original Node layer separately reports 145 npm packages, 230 legal files and four unresolved component texts. Inherited bytes are not erased by a runtime whiteout.
- Production npm audit reports zero findings at every severity; both lockfiles differ only in license metadata. Image/OS findings remain distinct and open.
- Fresh isolated installs and format/types/build/fast checks passed at patch boundaries three (369 cases, 28 suites) and six (373 cases, 30 suites). The full patch series also applied cleanly and matched its file-hash manifest.
- A 500-query Linux UDP DNS probe observed nineteen open descriptors before, at peak and afterward. This checks resource retention for that probe, not production throughput or reliability. The final Docker-only reviewer journey passed all three business checks and scoped cleanup.
- Linux ARM64 scanner archives passed pinned checksum verification and executed in isolated Linux containers. Actionlint, shell syntax and release-policy cases passed. The successful-foundation preflight query was exercised against the known hosted run.
- The complete gate passed all seventeen controls and 59 criteria on the frozen candidate: 373 fast tests in 30 suites, 215 PostgreSQL cases in six suites, twelve workflow cases and Recall@5 of 0.95 with the same two recorded misses. Source digest: `6d1a7b32cb86d12ee5eab381314f40eff7fccc986ae4da9bad1bf2e1435cabf9`; base revision `557b471`, working tree dirty as expected for pending patches.

## Remaining release boundaries

The prepared workflow remains blocked by the committed gate record, high/critical OS findings and inherited-layer notice review. Code patches still need exact approval before commits. Native hosted CI, actual GHCR pushes/visibility, anonymous published-image journeys, protected environment configuration and GitHub prerelease creation have not been executed. No signed provenance or production support is claimed.

Policy choices are recorded in [the owner-reviewed policy](../../release/policy-options.md), distribution scope in [third-party notices](../../../THIRD_PARTY_NOTICES.md), and the prepared publication protocol in [the release procedure](../../release/publication.md).
