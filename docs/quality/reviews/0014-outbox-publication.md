# Recoverable outbox publication protocol

Status: exact patch approved by the owner and committed as `587f3bb`; not pushed. Base `c5ec3c6` contains the approved ticket-read patch. This slice implements SQL ownership and publisher coordination from ADR-0001. Tests use publisher doubles; no application Kafka SDK, real broker publication, relay startup loop or consumer is wired.

Proposed commit: `feat: add recoverable outbox publication protocol`.

## Files and behavior

- `database/migrations/1795132800000_outbox-publication.cjs`: availability, claim token/expiry, attempt count and allowlisted last-error fields; paired-claim/published-state constraints and a partial pending-event index. Relay gets SELECT on outbox and UPDATE only on publication metadata. No event-content INSERT/UPDATE/DELETE or ticket-message access is granted. Existing payload bytes/digests and published flags are retained; destructive rollback is refused.
- `apps/worker/src/outbox-publications.ts`: API-independent PostgreSQL adapter. At most 20 eligible rows are claimed with SKIP LOCKED and a fresh UUID token for a 30-second database-time lease. Short transactions use `lab_relay`, finite lock/statement/idle bounds and a caller-owned bounded pool. Confirmation/retry acquires the row lock before checking token, unpublished state and current database time. Failed sends keep pending work with a one-second eligibility delay and safe code.
- `apps/worker/src/outbox-relay.ts`: narrow publisher port, fixed topic/key mapping, immutable-byte digest verification, complete 10-second send deadline, optional cancellation and no SQL transaction during publication. A late publisher result never acknowledges after timeout. SQL marking errors after publisher acceptance propagate rather than being reclassified as send failure. Unstarted claims remain recoverable on expiry. Successful publication marking never changes execution state.
- `apps/worker/package.json`, root `package-lock.json`: direct pg/@types/pg 8.23.1 declarations already resolved elsewhere; no version upgrades or Kafka packages.
- `tests/outbox-relay.test.cjs`, database submission/foundation tests: deadline/cancellation, ownership, crash-window and privilege evidence plus seeded upgrade paths. Existing default worker stays idle with no credential mounts.
- Short README/map/roadmap/data-model updates, this report and [proposed ADR-0006](../../adr/0006-local-kafka-relay.md): current scope and the concrete next application-client approval boundary. The proposal itself does not change runtime behavior.

## Actual verification on 2026-11-20

Red: after successful ticket creation in the test database, the first claim test failed because the publication adapter was absent. After implementation:

- `npm run check`: formatting, builds/type checks and **79 fast tests** passed. Fake timers verify full send timeout, best-effort abort, no late acknowledgement, pre-aborted batches, stale-claim skipping, error classification after send acceptance and separate terminal-notification topic mapping.
- `npm run test:database`: **94 real PostgreSQL tests** passed. Concurrent claims are disjoint and skip a held row. Claims remain durable/unpublished while a controlled publisher waits; pg_stat_activity shows no relay transaction remains open during that wait. Same immutable bytes/event ID survive retry and the accepted-send-before-mark crash checkpoint, where duplicate publication is deliberately possible.
- Expired/stale tokens cannot mark or reschedule a replacement claim. An unchanged row is held through a short fixture lease expiry; marking waits for the lock, then rejects using fresh database time. A real SQL marking commit followed by a simulated lost acknowledgement leaves the row published and non-retryable. No claim of exactly-once publication is made.
- Invalid stored digests are never sent; failures persist only INVALID_EVENT/PUBLISH_FAILED. Relay content mutation/deletion and ticket-message reads are denied. Batch sizes outside 1-20 are rejected. Publisher doubles do not establish actual broker acknowledgement or native SDK compatibility.
- Seeded two-, three- and four-migration databases upgrade while retaining credentials/unrelated rows. The four-migration fixture also creates a pending ticket/event before upgrade, then verifies exact payload/digest/message and initial unclaimed metadata afterward. Repeat migration is a no-op.
- `npm run test:compose` passed the existing real HTTP/Redis/PostgreSQL flow, recovery, persistence, private mounts and secret-log/failure gates with the fifth migration. No worker polling or publication is fabricated by that run.

`npm run test:containers` also passed API/worker builds, isolation, safe failures and shutdown; the default worker still reports idle. Final formatting, relative documentation links and whitespace checks passed. Environment remains macOS arm64, Docker 29.2.1/Linux arm64, Node 24.22.3 and PostgreSQL 17.12/pgvector 0.8.7. Audit reports 24 moderate affected tool-graph entries and 0 API/worker production findings; native/OS scans did not run. The partial index is not a measured throughput or hardware claim.

## Remaining gate

The network double is an explicit port test, not Kafka delivery or EVENT-family completion. A send that succeeded before a crash/timeout may repeat; future inbox/job admission must deduplicate. Database ownership fences publication marking, not every possible external send. A caller must configure connection/query deadlines and error handling; signal cancellation does not forcibly cancel arbitrary SDK work or promise complete worker shutdown by itself.

The next reviewed slice is [ADR-0006](../../adr/0006-local-kafka-relay.md), which proposes the evaluated Confluent client and an opt-in local relay. The owner subsequently approved ADR-0006 on 2026-11-20; its implementation evidence belongs to [review 0015](0015-local-kafka-relay.md). No release, hosted operation, consumer, executor or AI behavior is introduced here.
