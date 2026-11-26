# Phase six: reviewer contract, reproducibility and CI preparation

Status: prepared against published phase-five head `c3b304c04c17ef18a77a2f081bccb12004d8830b`. These are new exact patches awaiting owner review for code/configuration commits. The owner left license and private reporting undecided for analysis. The phase-five approved aggregate was already published as nine smaller commits; no history was amended or rewritten.

## Proposed small commits

1. `fix(ci): install host dependencies before ARM workflow evaluation`
   - One workflow file: install the lockfile before the final ARM host TypeScript/workflow evaluation and correct the old built-ins-only comment.
   - The published ARM job failed TS2688 because Node type definitions were absent. Earlier Docker journeys passed, and x64 passed its full integration job. An isolated checkout of the exact published source validates a fresh install followed by twelve successful scripted cases.
   - This fix can be reviewed and published independently of the remaining phase-six work. New hosted success is not claimed before push.
2. `fix: patch the migration tool glob dependency subtree`
   - Root manifest override plus lockfile only. Keep `node-pg-migrate` 9.0.0 and unrelated locked versions; resolve its scoped glob to 14.0.2 with minimatch 11.0.9.
   - Before: three moderate production audit entries. After: zero production findings, consistent fresh install/dependency tree and all 215 real PostgreSQL tests passed. Crossing the tool's declared glob major range is explicit and tested; no force downgrade or advisory suppression is used.
3. `feat: export the implemented HTTP contract as OpenAPI`
   - Pure API contract/schema module, fixed exporter, twenty actual HTTP contract tests and one root command.
   - Document the five implemented operations, bearer authority, strict bodies, receipts, safe errors/headers, lifecycle states and legacy/agent summaries. Existing Zod conversion emits the schemas; descriptions retain server-only UTF-8, trimming, ownership and cross-field rules. No new endpoint, model adapter or SDK is introduced.
   - Host and image exports are byte-identical. This does not claim independent full OpenAPI metaschema validation or persisted tenant provenance from mocked HTTP service fixtures.
4. `test: verify the reviewer journey from an isolated source archive`
   - Source snapshot helper, one meaningful staged/unstaged/ignored-file unit test, Docker-only journey driver and root command.
   - A temporary Git index captures candidate source without modifying owner staging. The archive has no Git metadata, host application packages or builds. Driver operations use Docker/CLI only for both tenant demos, duplicate receipts and queued-work recovery; no direct SQL admission/completion is performed.
   - Record exact source/environment, existing-cache startup observations, four resource checkpoints and scoped cleanup. Failure or source changes fail the report. The final local journey passed.
5. `ci: check production advisories and reviewer artifacts`
   - Separate workflow additions for OpenAPI export, moderate-or-higher production audit gating and reviewer quickstart on x64/native ARM64; retain every prior control and read-only permissions.
   - Requires the preceding candidate commands and dependency fix. No artifact publication, registry secret, privileged target-context workflow or release tag is added. Actionlint passed; hosted phase-six success remains unverified.
6. `docs: record migration dependency advisory triage`
   - Public advisory references, reachability, scoped override, lock-generation details and explicit scan limitations.
7. `docs: compare release license and reporting options`
   - Primary-text MIT/Apache-2.0 comparison and private-reporting setup alternatives, with owner decision points. No license/contact/settings are selected.
8. `docs: record reviewer readiness and phase five publication`
   - Verified Docker commands and measured observations; current readiness/CI records; publication of the nine phase-five commits; remaining release boundaries and owner decisions.

The external manifest includes full diffs/new files, affected paths, proposed messages, hashes and validation evidence. Shared root script/workflow edits are partitioned by purpose so the initial CI fix remains independent. Preparing patches does not stage or commit these new changes.

## Validation and limits

TDD red: OpenAPI export failed at `OpenAPI export not implemented`; source snapshot failed at `Source snapshot not implemented`. After implementation the real loopback HTTP suite passed twenty cases and the Git snapshot fixture passed while preserving staged source. The test invokes the ESM helper through a normal Node subprocess, so it does not require changing Jest's default VM mode.

Final host checks passed 366 tests in 27 suites, builds/types/format, and all 215 SQL cases in six suites with the candidate dependency graph. The five-operation image export exactly matched the host export. The reviewer journey ran from fresh isolated source/volumes, passed both tenant demos, stable receipts and stopped-executor recovery, measured four checkpoints and cleaned its resources. Build cache was existing; 608 ms CLI build, 20,508 ms startup and 21,116 ms combined are observations, not hardware guarantees.

The original host npm retained stale override entries; an isolated official npm 12.2.3 refresh of the migration subtree produced the final consistent lock, which then installed successfully with host npm 10.2.4. The post-change production audit has zero findings. Development-only dependencies, OS/image scans, secret scanning and full license inventories remain separate, uncompleted release work.

The first published phase-five CI run is not green: ARM's final host build lacks installed Node types. Its minimal candidate setup correction has local clean-checkout command evidence and still requires hosted verification after approval/push. OBS-CLI-01 remains the separately recorded unclassified local collector-outage CLI failure; subsequent strict local and hosted integration checks passed, without proving a causal fix.

No public working release is eligible yet. Registry/release identity, image manifests and scans, license/reporting choices, remaining investigation and explicit publication authorization remain in the readiness record. This patch series does not change repository visibility, invent a private contact or deploy a service.
