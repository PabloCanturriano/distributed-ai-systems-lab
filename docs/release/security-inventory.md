# Phase-six image and secret audit

Status: measured on 2026-11-26 against published source `a3da5c09fc3e473432df67beb2488035d97e13f6`. This audit is not a release approval. The subsequent runtime-tooling patch below is uncommitted and awaits exact-patch approval.

## Method and evidence

- Gitleaks 8.30.1 scanned 77 commits in the local Git history and a separate `git archive HEAD` source snapshot, using default detection rules and fully redacted reports. Both scans returned exit 1 with the same two findings. Manual classification found no confirmed credential in those findings; this does not prove all secrets are absent.
- Trivy 0.76.2 scanned all eighteen local image identities referenced by `docker compose --profile '*' config --images`, including initialization targets. Application images were built from the published source before the runtime patch. All are Linux ARM64; x64 security results are not established by this run.
- Official macOS ARM64 scanner archives matched their publishers' downloaded SHA256 checksum files. Signature verification was not performed. Tools were installed temporarily outside application dependencies.
- The vulnerability database was updated at `2026-11-26T13:14:47Z`, downloaded at `2026-11-26T14:29:29Z`; Java indexing was also downloaded for Kafka. Scanning used `--scanners vuln,license --license-full --format json`, without severity filtering or ignoring unfixed findings. All eighteen scans completed with exit 0: that is scanner execution success, not a security gate pass.
- Local ignored evidence is under `artifacts/release-audit-2026-11-26/`: detailed package/vulnerability/license JSON, image identities, summary and a SHA256 manifest. Raw history reports and logs remain outside the repository; no credential volumes, running environment or database contents were scanned or published.

## Secret finding classification

| File                                                     | Finding                                                    | Classification                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `docs/quality/reviews/0009-kafka-client-selection.md:48` | Generic API-key rule matched the release API digest        | Public SHA256 artifact identity, not an authentication credential |
| `docs/quality/reviews/0006-compose-foundation.md:44`     | Generic API-key rule matched prose after “API publication” | Ordinary liveness/readiness test prose, not a credential          |

The same content was checked in the historical commits identified by the reports. No broad allowlist, source suppression or history rewrite was introduced. The reported finding count remains two rather than being relabeled as a clean scanner exit.

## Baseline image inventory

Counts are raw vulnerability records in **critical/high/medium/low/unknown** order. One CVE may affect several binary packages and recur across images; these are not unique exploitable application defects. “Fix available” counts records with a nonempty scanner `FixedVersion`, without asserting that the current image publisher supplies an updated image. Package counts reflect scanner recognition, not exhaustive native/static-code coverage.

| Image/target                                      | C/H/M/L/U        | Fix available | Packages | Local image identity                                                      |
| ------------------------------------------------- | ---------------- | ------------- | -------- | ------------------------------------------------------------------------- |
| `relay`                                           | 1/44/118/88/18   | 19            | 390      | `sha256:52e6902ba5aa3fa20e02866aeed0986de01ba199c37d7c10c0613d3b7b36935a` |
| `executor`                                        | 1/44/118/88/18   | 19            | 390      | `sha256:e895d19059946b7d7d33e070dd3ccbd567dbc9ef73836d038a5f33fe0bf73b4d` |
| `cli`                                             | 1/44/118/88/18   | 19            | 235      | `sha256:235a64e283aef08e43dbca4e8c0bfe2fea392932fb5eaa6b74f400c241eb102f` |
| `migrate`                                         | 1/44/118/88/18   | 19            | 277      | `sha256:64be8d5cb0987e12e665d3e63861567377eb8707d2df8654ac3e290e34ad3c7e` |
| `bootstrap`                                       | 1/44/118/88/18   | 19            | 277      | `sha256:60f4fa07a08fb22af0c866c97c7a0de810bfbfa4cf888afec2aa8d41e833fd4a` |
| `worker`                                          | 1/44/118/88/18   | 19            | 390      | `sha256:f7985dfc7eb7450d8c5498c8b223fcb39023fd2cf17149b574fc577292a4daa7` |
| `cr.jaegertracing.io/jaegertracing/jaeger:2.23.0` | 0/4/10/4/1       | 19            | 348      | `sha256:3823829974ccfc2485d2e48b165579091f32295022ae80ca49704e2f4834116e` |
| `pgvector/pgvector:0.8.7-pg17-bookworm`           | 4/141/243/200/34 | 62            | 159      | `sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd` |
| `kafka-init`                                      | 1/11/16/7/0      | 35            | 164      | `sha256:1c192ec81975ca82d6e1322aab45ab0462c5059533fa216b57574a96d7b29275` |
| `operations`                                      | 1/44/118/88/18   | 19            | 252      | `sha256:d97872b1c789cceabba8dfde2a2be20f56b50bb9b0675201c164ab5efbeeb279` |
| `seed`                                            | 1/44/118/88/18   | 19            | 277      | `sha256:8266706d2ebc958cf543bdc48583be4ffbd769470c5a6713f6b1930cf97cddb4` |
| `consumer`                                        | 1/44/118/88/18   | 19            | 390      | `sha256:801ce8afd323e88b7c62218b2c521d17d45a0f76495902dbbe607bc3ccd3db00` |
| `apache/kafka:4.4.0`                              | 1/11/16/7/0      | 35            | 164      | `sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| `secrets`                                         | 1/44/118/88/18   | 19            | 277      | `sha256:427847fd8bf9c1bebab4300898f0cd287c3b804cb6510e8c26c208d8d7f47f58` |
| `otel/opentelemetry-collector-contrib:0.165.0`    | 0/0/1/0/1        | 2             | 1089     | `sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea` |
| `redis:8.10.3-trixie`                             | 0/52/98/74/15    | 33            | 78       | `sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53` |
| `prom/prometheus:v3.16.0`                         | 0/2/4/0/2        | 8             | 441      | `sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06` |
| `api`                                             | 1/44/118/88/18   | 19            | 365      | `sha256:f5d634290614478e26a6c610b4bacd64cbdeed2030d4714f6edf7a87640f1bfc` |

All baseline Node application images have the same 269 records: 250 Debian records and nineteen npm dependency records under `/usr/local/lib/node_modules/npm/`. These npm findings do not come from `/app/node_modules`; the previous production-source audit and this image audit cover different inventories. The application lockfile override does not update the base image's npm installation.

### Initial triage and limits

- The Node image's reported critical `CVE-2023-45853` concerns MiniZip. The [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2023-45853) explains that the affected contrib/minizip code is not built by bookworm's zlib source package. This is a vendor applicability distinction, not permission to discard every zlib or Debian finding. The raw record remains in the evidence.
- Npm carries vulnerable transitive packages, including brace-expansion and undici. Examples are the upstream [brace-expansion advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-6j4f-fj2g-mc7p) and [undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx). Runtime entry points invoke Node directly; no package-manager operation is needed after the build.
- PostgreSQL/pgvector, Kafka/bootstrap, Redis, Jaeger, Prometheus and the collector still have findings. Critical record names across the baseline include zlib, Go stdlib, SQLite, brotli and libxml2. Apart from the bounded zlib check above, full vendor/reachability triage and candidate pinned-image upgrades remain pending. Non-root execution and private networks do not establish non-exploitability.
- The license pass inventories detected files/package licenses, including unknown classifications and copyleft categories. It does not judge compliance, select the owner's license or produce a complete redistribution NOTICE bundle. The collector's zero detected license records despite 1,089 recognized packages is a coverage limitation, not a license-free declaration. Static native addon dependencies, Go notices and distribution-specific obligations need explicit review.

## Proposed runtime-tooling removal

The uncommitted patch removes npm, npx, Yarn launchers and the Yarn installation from the shared final runtime stage. Build/dependency stages retain their installers. No dependency version, base digest, application command or trust boundary changes.

Affected implementation files: `infra/docker/Dockerfile` and `scripts/container-smoke.mjs`. Proposed commit: `fix: remove package managers from runtime images`.

Actual validation:

1. The new container assertion failed against the original image because `/usr/local/lib/node_modules/npm` existed.
2. With the runtime change, API and worker passed actual startup, non-root/read-only isolation, absent-tool assertions, safe invalid-mode rejection and shutdown.
3. The isolated reviewer journey passed both tenant demos, stable duplicate receipts and stopped-executor recovery, including scoped cleanup.
4. A separately rebuilt API image (`sha256:b8c0535db171283533bc6af74dc201b83d177b06a16b8738e202f24d26291d78`) was rescanned against the same vulnerability database. Records fell from 269 to 250; all nineteen npm-package records disappeared (six high, twelve medium and one low). The remaining counts are **1/38/106/87/18**, all attributed to Debian packages. This is a measured API result; the shared Docker stage applies to other roles, but they have not all been individually rescanned after the patch.

Node's built-in libraries, including bundled fetch code, are not proved free of vulnerabilities by removing the separate npm installation. This patch does not close the remaining base-image or third-party findings. The original final-image layers still exist in the build cache; deletion concerns the merged runtime filesystem, not erasure of parent layers.

## Remaining work

1. Review and approve the exact runtime patch before committing it, then validate it in hosted CI.
2. Triage remaining fixable high/critical third-party image findings, choose narrowly scoped pinned updates and run their real integration suites before requesting approval. Record vendor applicability decisions individually.
3. Complete license/NOTICE review, including unknown and statically linked components.
4. Keep OBS-CLI-01 open until its historical exit-4 failure has a supported classification; later green runs are not a causal fix.
5. Resolve the owner's deferred license/private-reporting decisions and define registry/release identity before implementing artifact publication.

The approved stage-six source did pass [all four hosted CI jobs](https://github.com/PabloCanturriano/distributed-ai-systems-lab/actions/runs/45735028140). CI-ARM-01 is resolved; image/release readiness remains in progress.
