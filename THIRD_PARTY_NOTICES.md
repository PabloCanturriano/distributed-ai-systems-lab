# Third-party notices and distribution scope

Project source is licensed under Apache-2.0. Third-party components retain their original licenses, copyright statements and attribution requirements. The root `NOTICE` does not replace their notices.

## Project-owned application images

Each release candidate must include a notice bundle for each of the API, worker, relay, consumer, executor, CLI, operations and database images. The prepared exporter reads installed artifacts in a read-only, network-disabled container. It preserves exact text bytes under content hashes and records package name, version, declared license, original file path, image identity and Debian source-package versions.

The inventory includes the Node distribution's `/usr/local/LICENSE`, Debian `/usr/share/doc` license/copyright files, package-level notices, license text embedded in package READMEs, and the Confluent client's bundled librdkafka notices. Detection and inventory are not a declaration that every redistribution obligation has been satisfied; source availability and any unrecognized/static components need a final review for the actual released image.

Run the prepared command with a local immutable image identity:

```sh
node scripts/export-image-notices.mjs sha256:<64-hex-image-id> artifacts/notices/<role>
```

The output directory must be new or empty. `manifest.json` maps original paths to exact SHA256-addressed files under `texts/`. Missing text and unresolved links remain explicit and block the prepared release gate. The tool does not download guessed license files.

## Supplemental texts with recorded provenance

| Package               | Reason                                                                                                                                                                                                                                                         | Preserved upstream text                                                                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tr46@0.0.3`          | Its published manifest declares MIT, but the old tarball and its recorded Git tree omit a license file. The same upstream later added its MIT notice; the supplement retains the upstream author's notice, without claiming that the old tarball contained it. | [`third-party/licenses/tr46-MIT.txt`](third-party/licenses/tr46-MIT.txt), from [upstream revision `feff5a1`](https://github.com/jsdom/tr46/blob/feff5a1db5fbae23242c15efa4e64f71c9750af0/LICENSE.md); SHA256 `499d6d466d064e0460427967a344e2a32fcb86ea8c6cd1a285ec4f1fa03fba67` |
| `@redis/client@6.3.1` | The npm tarball omits the root license of its source repository. The supplement is taken from the exact `gitHead` recorded in that version's registry metadata.                                                                                                | [`third-party/licenses/redis-client-MIT.txt`](third-party/licenses/redis-client-MIT.txt), from [upstream revision `492cb2e`](https://github.com/redis/node-redis/blob/492cb2e62d4f857b1990e47ed6bbfc8467473698/LICENSE)                                                         |

The separate MIT notices for `@tokenizer/token`, `pg-types` and `pgpass` are present inside their installed READMEs and are exported unchanged. No invented copyright holder or generic replacement notice is used.

The Kafka client also preserves `LICENSE.txt`, `LICENSE.kafkajs`, `LICENSE.node-rdkafka`, and the bundled librdkafka component notices. Native artifact checksums establish identity, not complete static-component security/license coverage.

## Upstream service images

Compose references the publishers' pinned PostgreSQL/pgvector, Kafka, Redis, collector, Jaeger and Prometheus images. The project does not mirror these images into its GHCR namespace. Their operating-system and upstream licenses remain separate from this repository's Apache-2.0 source license.

Redis server 8 offers AGPLv3, RSALv2 and SSPLv1 alternatives; see the [publisher's license policy](https://redis.io/legal/licenses/). This is distinct from the MIT-licensed Node Redis client. The prepared local evaluation policy selects the AGPLv3 option and records the [8.10.3 source revision](https://github.com/redis/redis/tree/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f) and [publisher's terms at that revision](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/LICENSE.txt). Any future modified Redis distribution or hosted service needs its own review; the current scope is an unmodified, locally pulled upstream service image.

The Debian packages in project-owned images also retain their individual terms. Keep the recorded source-package versions, corresponding source availability and preserved copyright texts with release evidence. A machine-generated SBOM alone is not a source offer or a complete NOTICE review.

## Filtered-runtime candidate and corresponding sources

The new uncommitted packaging candidate exports only Node and its required glibc/libgcc/libstdc++ files into an empty OCI base; it does not inherit official Node image layers. Its ledger preserves exact file hashes, Debian binary/source package versions and original copyright texts. The release preparer rejects shared base layers, mismatched runtime ledgers and missing notices. This removes the previously recorded four missing npm-tool notices from the distributed candidate by excluding their bytes, rather than substituting unrelated license text. Existing published source still uses the earlier runtime until this patch is approved.

`scripts/export-runtime-sources.mjs` archives the exact `base-files`, `glibc` and `gcc-12` source packages represented by the retained runtime. It verifies Debian Snapshot file identity and size, then checks archive SHA256 values against the source descriptor. The descriptor signature is not independently verified. Actual local output contains three source packages and eight files; the per-architecture release evidence must retain them with its checksummed manifest. Downloaded sources are not executed or extracted.

## Native supplemental notice references

These original upstream legal texts are included in the candidate and notice export. They supplement the vendor's original bundled notices; they do not by themselves establish a complete native bill of materials or a corrected binary.

| Text                                                                     | Upstream identity                                                                                      | SHA256                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [OpenSSL](third-party/licenses/LICENSE.native-openssl.txt)               | [openssl-3.5.8](https://github.com/openssl/openssl/blob/openssl-3.5.8/LICENSE.txt)                     | `7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a` |
| [zlib](third-party/licenses/LICENSE.native-zlib.txt)                     | [v1.3.2](https://github.com/madler/zlib/blob/v1.3.2/LICENSE)                                           | `e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2` |
| [Zstandard](third-party/licenses/LICENSE.native-zstd.txt)                | [v1.5.7](https://github.com/facebook/zstd/blob/v1.5.7/LICENSE)                                         | `7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8` |
| [curl reference](third-party/licenses/LICENSE.native-curl-reference.txt) | [revision d5ec024](https://github.com/curl/curl/blob/d5ec024cf205997c6a3416b2998953ce7cf23fcb/COPYING) | `82f2f4427d6545ee5aaac4f0b80428da6cc8ba41c2cf5da3a03680ec327b9681` |

The curl text is an explicitly identified reference, not evidence of the embedded curl version. Zstandard 1.5.7 is confirmed by the ARM64 addon's version function. Its missing security correction is recorded in [ADR-0010](docs/adr/0010-reproducible-kafka-native-build.md). The complete native notice/security gate remains open pending a source-identified build or corrected vendor artifact.
