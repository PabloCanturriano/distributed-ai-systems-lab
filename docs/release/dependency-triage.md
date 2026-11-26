# Production dependency triage for phase six

Status: candidate fix prepared for exact-patch review. The repository's existing `node-pg-migrate` version remains 9.0.0; no direct application dependency is upgraded or downgraded.

## Observed findings

An initial `npm audit --omit=dev --json` reported three moderate entries, no high or critical entries: `glob`, `minimatch` and the affected parent `node-pg-migrate`. The two underlying public advisories are:

- [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4): `glob` cancellation can leave traversal work running; the advisory identifies 14.0.2 as patched.
- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): amplification from attacker-controlled minimatch patterns; the advisory identifies 11.0.1 as patched.

The migration runner is a separate privileged one-shot image using the repository-owned migration directory. The application does not expose user-chosen glob patterns, paths or cancellation parameters to it. This limits reachability but does not remove vulnerable packages from the inventory, so no advisory was suppressed.

## Candidate change

A root override scopes `glob: 14.0.2` to `node-pg-migrate`. The lockfile resolves that subtree to patched `glob` and `minimatch` (11.0.9), retaining the migration tool's pinned version and all unrelated locked versions. The override crosses the tool's declared glob major range, so actual clean-install and historical migration compatibility tests are required. `npm audit fix --force` was not used; its suggested parent downgrade is not part of this patch.

The host npm 10.2.4 initially retained stale override/nested dependency resolutions. The final candidate was generated with official npm 12.2.3 in an isolated manifest-only directory after refreshing the migration subtree. A clean install with the host npm and `npm ls --all` succeeded afterward. The installed graph, rather than a package.json edit alone, is the validation target.

The post-change production audit reported zero findings at every severity. Development-only tools still contain older transitive packages; this is not a claim that a full development audit or OS/image/secret scan is clean. Before release, retain scan scope and findings, complete image and license inventories, and recheck against current advisory data.

## Evidence

Ignored local files `artifacts/dependency-audit-phase6.json` and `artifacts/dependency-audit-phase6-after.json` preserve before/after production audit results. The six real PostgreSQL suites passed 215 cases with the candidate graph, including clean schema creation and upgrades through migration 15. The Docker-only reviewer journey separately verifies image installs and bootstrap with the same lockfile. No public release or vulnerability-free certification is implied.

For a source-level inventory, `npm sbom --omit=dev --sbom-format cyclonedx > artifacts/source-sbom.cdx.json` generated 156 components. This is separate from the advisory scan and from the still-pending OS/image and license/notice inventories. It records the candidate dependency graph; it does not authorize publication or select the project license.
