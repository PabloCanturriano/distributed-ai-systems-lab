# ADR-0009: filtered Node runtime from the existing pinned image

Status: proposed implementation refinement within the accepted Node/glibc container architecture; exact-patch approval is required before commits. No service, dependency version, privilege, network destination, HTTP/event contract or delivery guarantee changes.

## Decision

Build/dependency stages retain the existing official Node 24.22.3 bookworm digest. A build-time exporter selects the Node executable, its exact shared libraries, glibc NSS libraries, CA data, distribution/package metadata, original common-license texts and package notices. The final runtime copies only that exported filesystem into an empty OCI base. Application-role files/dependencies are copied as before. UID/GID, read-only filesystems, capabilities and role commands remain unchanged.

The final image has no inherited official-image layers, package installers, shell, login tools, unused compression libraries or compiler headers. Removing files in a later layer alone would not accomplish this. A machine-readable ledger records source image identity, copied-file hashes, bundled Node component versions and retained Debian binary/source package versions. Preserve corresponding sources with release evidence. Do not suppress vulnerabilities by hiding package metadata: retain accurate dpkg status for every retained Debian package and scan the actual final image.

## Evidence and boundaries

Read-only `ldd` inspection of Node and the pinned Kafka addon found only glibc, libstdc++ and libgcc dependencies. NSS and trust data are retained explicitly. Validate both native architectures, real initialization/migrations, Kafka, DNS/outage recovery, CLI and the full application gate before publication. Unsupported loader dependencies or missing copyright/source records fail the exporter.

The supported console uses Node and the business CLI; interactive shell conveniences in the original vendor image are not a supported runtime interface. The external PostgreSQL, Kafka, Redis and observability service images remain upstream references and require their separate applicability review. This refinement does not certify production security or static native dependency completeness.
