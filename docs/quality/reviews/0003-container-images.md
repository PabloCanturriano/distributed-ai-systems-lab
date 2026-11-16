# API and worker container packaging review

Status: prepared for exact-patch review; not committed or pushed.

## Purpose and scope

The API and worker previously required host Node to run. This patch packages them into separate selectable runtime images using a shared multi-stage Dockerfile. It introduces no Compose deployment or business dependency wiring.

The official `node:24.22.3-bookworm-slim` multi-platform index is pinned to `sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`. The tested linux/arm64/v8 manifest is `sha256:5f8fabfed57b75127de2f584593d67a9e8c90e6b0f65652871f9ef0f759c0299`. Docker Hub's registry API and `docker buildx imagetools inspect` returned the same index digest. Digest pinning fixes the base identity; security updates require a reviewed digest change.

Build stages use lockfile installs with lifecycle scripts disabled. Final dependency stages select the relevant workspace and omit development dependencies. Runtime stages contain compiled outputs and run as `node`, with direct Node entry points. The build context uses an explicit input allowlist; host Git data, caches, environment files, and tests are excluded. The API has a bounded liveness healthcheck. No worker readiness is invented for the idle process.

## Proposed commit and files

Proposed message: `build: package API and worker in verified Docker images`.

- `.dockerignore`: allowlist source/manifests/TypeScript build inputs.
- `infra/docker/Dockerfile`: pinned base, build and production-dependency stages, separate API/worker targets, non-root runtime, API liveness probe.
- `scripts/container-smoke.mjs`: host-side Docker lifecycle checks and narrowly scoped resource cleanup.
- `package.json`: separate `test:containers` command; ordinary checks do not silently skip a required Docker test.
- `README.md`, `docs/README.md`, `docs/operations/local-environment.md`, `docs/operations/container-images.md`, and this review: current packaging state, commands, boundaries, and evidence.

No existing dependency version or lockfile changes are required. Review new files along with the complete diff before committing. Push permission for the previous configuration commit does not authorize committing or pushing this new patch.

## Validation on 2026-11-16

Environment: macOS arm64 host, Docker Desktop engine 29.2.1 reporting aarch64, linux/arm64 image execution, host Node 24.22.3 and npm 10.2.4. Docker Desktop was initially stopped and was started for this work. An initial registry lookup/build was interrupted after stalling. The public image lookup and pull then succeeded with a temporary anonymous Docker CLI configuration; operator settings were not modified.

- `npm run check`: formatting, three workspace type checks/builds, and all 40 tests in 3 suites passed.
- `node --check scripts/container-smoke.mjs`: passed syntax validation.
- `npm run test:containers`: both Docker build targets and packaging checks passed. Final runtime restrictions include UID greater than zero, Docker user `node`, a read-only root filesystem, all capabilities dropped, no-new-privileges, no privileged mode, and no mounts.
- API: an ephemeral port is published only on `127.0.0.1`; `/health/live` returns 200, `/health/ready` returns 503 with its safe body, and the actual Docker liveness probe reaches healthy status.
- Worker: no published ports, observed idle startup event, no HTTP readiness claim.
- Both runtime images resolve the shared configuration package. Neither includes Jest, TypeScript, host tests, Git/environment files, application source, or the other application's compiled output.
- Both roles reject a fictional sensitive invalid mode with exit code 1, no stdout, and only the fixed role-specific failure event on stderr.
- Both roles stop within Docker's 15-second grace period with an expected exit code (0 or SIGTERM/143), without SIGKILL. All uniquely named smoke containers and final image tags are removed afterward. Build cache and the base image remain available.

Container-image OS vulnerability scanning, cross-architecture execution, resource/startup benchmarks, full OPS/SEC acceptance, dependency recovery, Compose startup, registry publication, and CI remain not run. Existing Jest development dependency findings remain unresolved. These successful packaging checks do not complete phase 1 or establish production suitability.
