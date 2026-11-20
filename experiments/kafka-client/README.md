# Isolated Kafka client compatibility experiment

This is a test-only package outside the application workspaces. API and worker do not depend on it. The separate lockfile pins Confluent's client 1.11.0; application packages and their lockfile are unchanged.

## Run

From the repository root, with Node 24 and Docker running on Linux arm64/Docker Desktop arm64:

```sh
npm run test:kafka-client
```

The host runner needs only Node built-ins and Docker Compose. The Docker build installs from the experimental lockfile with all npm lifecycle scripts disabled, downloads exactly the reviewed Node ABI 137/Linux glibc arm64 addon, verifies its SHA-256, and extracts only the addon from the archive. No compiler or automatic source-build fallback is used. Other architectures fail the explicit artifact gate; no amd64 or host-native compatibility is claimed.

The runner uses unique project/container/image names. It starts only the existing Compose broker service, creates separate probe topics/groups and runs a non-root client container with a read-only root filesystem, dropped capabilities, no-new-privileges, no mounts and a 512 MiB memory limit. No host broker port or Docker socket is mounted into the probe. Cleanup removes only that invocation's container/image and Compose resources/volumes. Default developer installations are not reset.

## What is tested

The coordinator publishes fictional keyed records and verifies acknowledgement reports. Separate child-process consumers validate records and wait on explicit IPC checkpoints. A separate administrative connection reads broker committed offsets; it never decides whether a handler completed from its local callback state.

Checks cover sequential partition dispatch, no automatic commits across a declared 6.5-second observation window, SIGKILL redelivery, explicit next-offset commit/restart, unfinished-callback disconnect, two-member rebalance while blocked, disabled automatic topic creation, bounded publication failure and recovery of existing clients after broker restart. Native SDK logging is explicitly configured at level 0. Captured consumer, probe and broker logs are checked for fixture payload/key/secret markers.

These are transport checkpoints, not SQL admission transactions. No ticket tables, outbox/inbox, quarantine, job execution, schemas, telemetry or application readiness are implemented. See [scope approval](../../docs/adr/0005-kafka-client-compatibility-gate.md) and [actual evidence/limitations](../../docs/quality/reviews/0010-kafka-client-compatibility.md).

## Dependency inspection

Optional metadata-only audit using the isolated lockfile:

```sh
npm audit --prefix experiments/kafka-client
```

If downloading packages locally for source/license inspection, preserve disabled scripts:

```sh
npm ci --prefix experiments/kafka-client --ignore-scripts --no-audit --no-fund
```

That command alone does not install a usable native addon on the host. Native preparation is intentionally confined to the reviewed Linux arm64 Docker build. Do not enable general dependency installation hooks to work around this restriction.
