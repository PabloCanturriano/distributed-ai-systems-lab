# Persistent fictional identities

Status: trusted identity seeding is implemented and verified against PostgreSQL 17.12 and macOS private files. The [Compose foundation](compose-foundation.md) now wires database login provisioning and private credential volumes. [HTTP bearer authentication](../quality/reviews/0012-authenticated-ticket-http.md) is prepared for review; the CLI remains future work.

## Provisioning operation

The private database workspace exports `seedDemoIdentities(seed, directory)`. The caller provides a dedicated connected client whose current role is `lab_seed` and a trusted private directory path. The client must not already be in a transaction. The function owns its SQL transaction and returns only `{ status: 'created' | 'unchanged', fixtureVersion: 'identities-v1' }`; it emits no logs and does not return secrets.

The immutable `identities-v1` fixture contains two fictional tenants, Harbor Support and Summit Operations. Each has reader, requester, and operator principals. Non-secret aliases are `harbor.reader`, `harbor.requester`, `harbor.operator`, `summit.reader`, `summit.requester`, and `summit.operator`. Tenant/principal UUIDs and roles are fixed by this fixture version; credential lookup UUIDs and 256-bit secrets are generated independently on first provisioning.

Each raw secret is encoded as canonical base64url in `identities-v1.json`. PostgreSQL stores only SHA-256 of the decoded 32 secret bytes, the lookup UUID, and principal association. A separate `lab.seed_manifests` row binds the fixture digest and the canonical credential-manifest digest to this database. The submission adapter accepts `Authorization: Bearer <lookupId>.<secret>` using those two fields. It checks canonical base64url, compares digests with constant-time comparison, and resolves the current principal/tenant/role from PostgreSQL on every request. The [ticket CLI](ticket-cli.md) now assembles the header privately, pending exact-patch review.

The trusted parent directory must already exist. The credential directory must be owned by the process user and deny group/other access. Newly created directories use mode 0700; credential files must be regular files owned by that user with mode 0600 and at most 16 KiB. The manifest and its leaf directory must not be symbolic links. Parent paths and the host operator are trusted. Compose initialization verifies compatible UID-1000 ownership on Docker Desktop Linux named volumes. The prepared CLI uses the same ownership policy; other volume backends/platforms remain unverified. Windows provisioning is unsupported by this POSIX permission implementation.

## Initialization and recovery protocol

1. Start a bounded SQL transaction and take the identity-initialization advisory lock.
2. Inspect the database manifest. If initialization already committed, require the matching private file and verify its fixture facts, credential IDs, and digests. Preserve disabled, revoked, or expired status rather than re-enabling identities.
3. For a fresh database, reject collisions with the fixture's tenant/principal UUIDs. Validate any previously published pending file before reusing it.
4. If needed, write a new private temporary file and sync it, then publish the complete file with an exclusive hard link and sync the directory. Its parent entry is also synced during directory preparation. Never overwrite an existing manifest. File durability primitives follow [Node's filesystem API](https://nodejs.org/api/fs.html).
5. Only after file publication, insert the two tenants, six principals, six credential digests, and database manifest in one SQL transaction.
6. Commit. On failure, roll back SQL and retain the already published private file for a consistent retry.

A valid file without committed seed state can therefore be reused after a failed initial transaction. A committed database without its file is a provisioning error: the operation does not generate replacement credentials or recreate a missing directory. Changed files or fixture facts also fail rather than being silently repaired. An incompatible or corrupt pending file requires explicit operator investigation.

This is a coordinated recovery protocol across SQL and files, not a distributed transaction or proof against physical storage loss. Tests inject a SQL failure after file publication; abrupt process/power loss, filesystem durability across every storage backend, and ambiguous commit acknowledgements are not independently tested. An interruption may leave a private `.identity-*.tmp` file; initialization ignores it and never globally deletes temporary files. The published manifest remains authoritative.

There is no automatic credential rotation, repair, or destructive reset command. A future explicit reset must remove the selected database data and credential volume together. Raw files and private temporary names are excluded from Git and application build contexts. Do not print them, pass secrets in command arguments, or copy them into application images. The API reads database digests and does not mount the raw credential volume. The trusted Compose test operator reads the manifest inside a temporary seed-role container, sends controlled HTTP requests and prints only safe assertion status.

## Verification

```sh
npm ci --ignore-scripts
npm run test:database
```

Tests create only fictional data and random credentials in temporary private host directories and an isolated database, then remove their own resources. They assert safe result objects and compare hashes rather than printing raw secret values. See [review evidence](../quality/reviews/0005-local-identities.md) for precise coverage and limitations.
