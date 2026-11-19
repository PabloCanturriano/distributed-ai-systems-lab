# Local API and worker images

Status: initial packaging, verified on Docker Desktop 29.2.1 on macOS arm64. Ticket processing, Compose orchestration, database bootstrap, and dependency readiness remain future phase-1 work.

## Build and run

From the repository root, with a working Docker engine and network access to Docker Hub and npm:

```sh
docker build --file infra/docker/Dockerfile --target api --tag lab-api:local .
docker build --file infra/docker/Dockerfile --target worker --tag lab-worker:local .
```

Each final image contains the selected application's compiled JavaScript, the shared configuration package, production dependencies, and the pinned Node runtime. The API and worker targets must be selected explicitly. Multi-stage compilation and digest pinning follow [Docker's build guidance](https://docs.docker.com/build/building/best-practices/). Both images run as the official image's `node` user and start Node directly so termination signals reach the application.

Run the API in the foreground:

```sh
docker run --rm --name lab-api-local --read-only --cap-drop ALL --security-opt no-new-privileges --publish 127.0.0.1:3000:3000 lab-api:local
```

Run the idle worker in another terminal:

```sh
docker run --rm --name lab-worker-local --read-only --cap-drop ALL --security-opt no-new-privileges lab-worker:local
```

Stop these specific containers from another terminal:

```sh
docker stop --time 15 lab-api-local lab-worker-local
```

No volume or Docker socket is mounted. The API container binds internally to `0.0.0.0:3000`; the example publishes only on host loopback. The worker publishes no port. Startup overrides use the [validated settings](local-environment.md#implemented-local-startup-settings). If changing `API_PORT`, change the container side of the port mapping too; `EXPOSE` is image metadata and does not publish a host port.

Standalone API images default to disabled dependencies: their healthcheck calls `/health/live`, and `/health/ready` remains 503. With `API_DEPENDENCIES=local`, the healthcheck calls `/health/ready` and requires the [configured PostgreSQL/Redis prerequisites](api-readiness.md). Node probes have bounded request timeouts. The idle worker has no healthcheck because it cannot demonstrate job-processing readiness yet. No external credentials are needed; these commands do not submit or process a ticket.

## Repeatable packaging checks

With Node 24.22.3 and installed development dependencies on the host:

```sh
npm run test:containers
```

This host-side harness builds both targets, inspects runtime restrictions, checks real HTTP responses and liveness health, rejects unsupported configuration with safe output, and verifies SIGTERM shutdown. It uses unique test names, an ephemeral loopback API port, bounded polling, and cleanup limited to its own containers and image tags. It does not require or mount the Docker socket inside an application container. Docker retains ordinary build cache and the pulled base image; no global prune is performed.

The Docker-only manual path needs no host Node installation. The smoke harness is developer verification and does require host Node. It runs separately from `npm run check`; no CI enforcement is configured yet. See [packaging review evidence](../quality/reviews/0003-container-images.md) for exact image identity, actual results, and limitations.
