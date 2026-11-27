# ADR-0010: source-built Kafka native runtime

Status: proposed; architecture approval required before implementation.

## Problem

The pinned `@confluentinc/kafka-javascript@1.11.0` prebuilt ARM64 addon contains Zstandard 1.5.7. Its exported `ZSTD_versionNumber` returns 10507, and the inspected `ZSTD_checkContinuity` lacks the history-window bound in [upstream fix 0c9d297](https://github.com/meta/zstd/commit/0c9d297531a9f15a717ff24604afc0843b3b1427). This is evidence of an affected native component, separate from Debian package scans. The [Debian advisory record](https://security-tracker.debian.org/tracker/CVE-2026-124851) describes disclosure through crafted compressed data. The installed client enables Zstandard support. Private broker networking and ordinary uncompressed messages alone do not justify declaring the component absent or fixed.

The vendor remains at 1.11.0 in its [release list](https://github.com/confluentinc/confluent-kafka-javascript/releases). The current build checks pinned prebuilt bytes, but lacks a complete reproducible manifest of all statically embedded dependency versions and patches.

## Proposed decision

Keep the JavaScript client version, Node ABI, Kafka contracts, role boundaries, database transactions and offset/lease rules. Replace the downloaded addon with a native build from pinned upstream sources on native AMD64 and ARM64. Publish the exact source revisions, patch identities, build inputs, configuration, checksums, complete component notices and corresponding sources as candidate evidence. Do not change to an unrelated JavaScript Kafka client.

Use patched supported native dependencies, including Zstandard 1.6.0 or a verified upstream fix on the retained version. Inventory and review the actual zlib, OpenSSL, curl, LZ4 and Snappy build inputs instead of identifying versions from incidental strings. Preserve the current protocol features unless an explicitly reviewed build decision removes them. Pin the build toolchain and fail on an unexpected source, feature, ABI, unresolved library or missing notice. Build tools remain outside runtime images.

This authorizes implementation and testing only. Exact code patches, source availability, scanner results, both native CI gates and publication protections still apply. A successful OS scan cannot substitute for native-component review.

## Alternatives and consequences

Waiting for a vendor artifact with verified fixes avoids maintaining a native build, but currently leaves the release blocked. Suppressing the finding or advertising the entire stack as secure is rejected. Removing optional codecs changes the supported client feature set and would require an explicit separate decision.

A source build increases maintenance responsibility and build time. It must pass real Kafka publication/admission, offset/rebalance, crash recovery and collector-outage scenarios, the full application gate, startup/isolation checks and anonymous image journeys on both architectures before publication. Also review all upstream service-image findings; this decision does not waive them.
