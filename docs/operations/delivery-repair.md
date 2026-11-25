# Local delivery inspection and repair

Status: architecture approved in [ADR-0008](../adr/0008-local-delivery-repair.md); implementation passed local acceptance and is prepared for exact-patch review. No application endpoint exposes these operations.

## Inspect and plan

Use Node 24.22.3 or later in the supported 24.x line for the host runner. Run from the repository root against an existing project started with the current images/migrations. Build the on-demand image with `docker compose --project-name <project> build operations`. The host runner checks the running PostgreSQL container's Compose project and working-directory labels before starting the tool; a typo does not create a database.

```sh
node scripts/operations.mjs inspect --project <project>
```

Output contains environment UUID, bounded quarantine metadata and queued execution candidates. It contains no ticket question, raw Kafka bytes, bearer credential, SQL console or shell. A malformed delivery cannot establish a trustworthy target tenant or ticket; the operator must select the authoritative execution separately.

Create a private JSON input file (owner only, `chmod 600`) containing the inspected environment UUID, tenant/ticket IDs, generation, expected active scheduling event, source position/digest, reason and stable key:

```json
{
  "environmentId": "<environment UUID>",
  "tenantId": "<tenant UUID>",
  "ticketId": "<ticket UUID>",
  "generation": 1,
  "expectedEventId": "<active scheduling event UUID>",
  "source": { "partition": 0, "offset": "0", "digest": "<64 lowercase hexadecimal characters>" },
  "reason": "DELIVERY_RECOVERY",
  "key": "reviewed-delivery-repair-1"
}
```

Reasons are `SCHEMA_CORRECTED`, `SOURCE_CORRECTED` or `DELIVERY_RECOVERY`. Values above are placeholders, not executable fixture identities.

```sh
node scripts/operations.mjs plan --project <project> --input /private/path/input.json --output /private/path/plan.json
```

Planning is read-only. The runner creates a new private plan file and prints its confirmation digest and explicit target/source expectations. It refuses to overwrite an existing plan. Review this output before applying:

```sh
node scripts/operations.mjs repair --project <project> --plan /private/path/plan.json --confirm <printed-SHA256>
```

The digest binds the plan's semantic JSON, project, canonical repository directory, database environment UUID and expected state. The database revalidates the environment and target under a ticket lock. A wrong project, stale pointer/generation, nonqueued execution, existing job or changed source digest causes rejection. A confirmation hash is an explicit operator acknowledgement, not a cryptographic signature or protection against someone who already controls the host.

## Effects and retry

A successful repair writes a fresh canonical outbox event, advances only the scheduling pointer, stores a scoped receipt and appends the old/new event IDs, source digest, reason, request ID and actual database session actor to `delivery_repairs`. It preserves the generation, attempts, old events and quarantine. It rebuilds bytes from authoritative execution state and never executes quarantine bytes. Kafka and ordinary consumer admission remain required.

Keep the same plan and key after a lost acknowledgement. That key returns its original receipt even after execution completes; changing expectations with the same key conflicts. Creating a new empty database generates a new environment identity and invalidates old plans. A backup or clone can preserve that identity; the tool cannot distinguish a restored copy carrying the same identity. Project/directory and current-state checks still apply, and restoration requires its own reviewed procedure. Inspect current state before creating a new plan/key.

Both old and replacement scheduling events may arrive. One generation still has at most one job. The job records the actual admitted event, which is the causation of any later failure notification. Repair does not promise that the replacement event wins a delivery race. A replacement delivery may start a new trace; use ticket/generation and the audited old/new event IDs to correlate it with the original request.

## Authority and credential lifecycle

The operations image mounts only its own private database credential. It runs without a Docker socket, host port, business credential volume, elevated capability or writable root. The host runner invokes only fixed commands; it has the invoking human's Docker authority.

`lab_operations_login` can set only `lab_operations`. Column grants allow the reviewed module's minimal reads/inserts and scheduling-pointer update; they deny questions, authentication digests, outbox payload reads, job writes, lifecycle changes, history deletion and role escalation. Like the existing trusted API/worker database adapters, this is a trusted module boundary: SQL grants do not independently enforce every tenant, idempotency-operation or expected-state rule against a compromised module. `session_user` identifies the database credential, not an authenticated human operator.

Bootstrap adds the new credential separately from the five existing runtime logins. On an existing volume it creates material only when this new login is absent. A published file survives a failed provisioning transaction so a retry reuses it. Once the login exists, missing or invalid material fails closed; startup never silently rotates it. Existing credentials and the environment UUID are preserved during an additive upgrade.

The runner's disposable test projects may be deleted by their own harness. No normal repair command deletes volumes, changes business credentials, edits jobs or completes work on behalf of the executor.
