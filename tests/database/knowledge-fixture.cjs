// Synthetic empty corpus for persistence tests. Release fixtures are seeded separately.
const { randomUUID, createHash } = require('node:crypto');
module.exports.seedEmptyCorpus = async (client, tenantId) => {
  const snapshotId = randomUUID();
  await client.query(
    "INSERT INTO lab.corpus_snapshots(tenant_id,id,version,manifest_digest,profile_id,chunking_profile) VALUES($1,$2,'test-empty-v1',$3,'lexical-hash-v1','paragraph-utf8-v1')",
    [
      tenantId,
      snapshotId,
      createHash('sha256')
        .update('test-empty-v1:' + tenantId)
        .digest(),
    ],
  );
  await client.query(
    "INSERT INTO lab.tenant_corpus_profiles(tenant_id,snapshot_id,profile_id,policy_version,provider_mode) VALUES($1,$2,'lexical-hash-v1','extractive-simulated-v1','simulated')",
    [tenantId, snapshotId],
  );
  return snapshotId;
};
