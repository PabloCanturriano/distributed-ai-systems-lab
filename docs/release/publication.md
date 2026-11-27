# Evaluation release procedure

Status: source `e21d17f` is published and its foundation run passed on x64 and native ARM64. The owner authorized resolving all five release prerequisites on 2026-11-26. The repository is now public, GitHub private vulnerability reporting is enabled, and the `release` environment requires the owner's review and restricts deployments to `main`. No registry images or prerelease have been published. A filtered-runtime refinement is uncommitted pending exact-patch review; native and upstream-service findings still block release.

## Trust and authorization

The prepared workflow is manual and accepts only main plus an explicit `v0.x.y-rc.N` version. Its preflight requires a successful push-triggered foundation run at the exact source SHA. Preparation has read-only repository permissions and uses pinned actions/scanners. Application images never receive registry tokens or the Docker socket.

Native AMD64 and ARM64 jobs build the eight application roles, scan complete images, export CycloneDX inventories and preserve per-image legal texts, including an inherited Node-layer inventory in the published preparer. The new filtered-runtime candidate instead rejects inherited base layers, verifies the retained-files ledger and archives exact corresponding Debian sources. Exact historical Gitleaks fingerprints cover only the two reviewed documentation false positives; new findings fail. Unfixed high/critical findings, incorrect image identities/platforms, missing notices and unresolved links fail the candidate gate. No global ignore-unfixed or severity exclusion is used.

`publish=false`, the default, performs preparation only. A failing scan still leaves its bounded reports for seven days; it does not produce successful image archives or publish anything. Raw application logs, environment dumps, credential volumes and database contents are excluded.

Publication requires all of the following:

- Owner approval of the exact implementation patches, committed source and successful foundation CI.
- Closure of the committed release-gate record with evidence; current open issues intentionally block publication.
- A public repository, enabled GitHub private vulnerability reporting and a configured `release` environment with required reviewers. The workflow checks these prerequisites before registry authentication; an automatically created unprotected environment is insufficient.
- Explicit `publish=true` and environment approval. Package-write permission exists only in the image-push job; release-write permission is separated into finalization.

## Artifact paths and verification

Image archives are bound to checksummed manifests and the source SHA. Publication loads and verifies both architectures before the first registry mutation. Each role receives an explicit version tag and a multi-platform manifest; `published-manifest.json` records immutable digest references. No `latest` tag is created and existing Git release tags are not moved.

The published-image journey must pull those references anonymously on both native architectures and run both tenant demos, stable duplicate receipts and stopped-executor recovery from new volumes. The application roles use only the published images; the tiny pinned broker initialization image is still built locally from the source-controlled bootstrap script. No host npm install or model credential is required by that journey.

Only after both journeys pass may finalization create the GitHub prerelease and attach the immutable manifest and per-architecture scan/SBOM/notice evidence. New GHCR packages may initially be private: the owner must configure their intended visibility, and anonymous-pull verification must pass before a public release is advertised. A failed push may leave partial registry artifacts; inspect them and use a new candidate version rather than treating a partial run as a release.

The pipeline checks repository visibility, reporting and release reviewers; their current settings were configured separately under the owner's instruction. It does not configure package visibility, branch protection or a hosted deployment. It does not claim signed provenance or production security support.

## Local checks and limits

Use `npm run check`, actionlint and the real Docker checks appropriate to each patch. The scanner installer verifies pinned archive checksums; these are not independent signature attestations. The release policy has executable cases for mutable/source/role/platform rejection and unresolved critical findings.

A real GHCR publication, anonymous multi-platform journey and GitHub prerelease are intentionally not represented as tested until actually observed. Current security/OBS findings remain release blockers; see [the security inventory](security-inventory.md) and [phase-six readiness](../quality/phase6.md).
