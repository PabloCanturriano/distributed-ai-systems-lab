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

## Inherited-layer review

Deleting npm/Yarn from the merged runtime filesystem does not remove their bytes from inherited OCI layers. A separate inventory of the exact Node base image therefore accompanies the application-role inventories. The observed base contains 145 npm packages and 230 detected legal files; four package texts remain unresolved: `@npmcli/agent@4.0.2`, `@sigstore/verify@3.1.1`, `spdx-exceptions@2.5.0` and `spdx-license-ids@3.0.23`. Their declared terms are respectively ISC, Apache-2.0, CC-BY-3.0 and CC0-1.0.

The exact recorded source trees were inspected. A fixture's license must not be substituted for the agent's license, and a declaration/link is not relabeled as an archived complete notice. The prepared release builder inventories the base separately and blocks incomplete inherited-layer notices. The final notice/source-availability gate remains open until these records and native/static coverage have been reviewed; zero missing package texts in the eight merged application images does not close it.
