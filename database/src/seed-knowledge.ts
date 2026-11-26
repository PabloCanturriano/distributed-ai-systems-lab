import type { Client } from 'pg';
import {
  chunksFor,
  chunkingProfile,
  retrievalProfile,
  policyVersion,
  sha256,
  parseCorpus,
} from '@lab/knowledge';
// Only the initializer calls this boundary with the repository-owned manifest.
export async function seedKnowledge(
  seed: Pick<Client, 'query'>,
  input: unknown,
  selectedPolicy:
    'extractive-simulated-v1' | 'bounded-agent-v1' = policyVersion,
): Promise<{ status: 'created' | 'unchanged'; snapshots: number }> {
  const manifest = parseCorpus(input);
  if (!['extractive-simulated-v1', 'bounded-agent-v1'].includes(selectedPolicy))
    throw Error('Invalid corpus policy');
  let created = false;
  await seed.query('BEGIN');
  try {
    const identity = await seed.query(
      "SELECT current_user='lab_seed' AND NOT rolsuper AS allowed FROM pg_roles WHERE rolname=current_user",
    );
    if (!identity.rows[0]?.allowed) throw Error('Knowledge seed role required');
    await seed.query(
      "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'",
    );
    await seed.query('SELECT pg_advisory_xact_lock(41017,4)');
    for (const tenant of manifest.tenants) {
      const digest = sha256(
        JSON.stringify({
          version: manifest.version,
          tenant,
          profile: retrievalProfile,
          chunking: chunkingProfile,
        }),
      );
      const existing = (
        await seed.query(
          "SELECT encode(manifest_digest,'hex') AS digest FROM lab.corpus_snapshots WHERE tenant_id=$1 AND id=$2",
          [tenant.tenantId, tenant.snapshotId],
        )
      ).rows[0];
      if (existing && existing.digest !== digest)
        throw Error('Immutable corpus changed');
      for (const doc of tenant.documents) {
        await seed.query(
          'INSERT INTO lab.documents(tenant_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [tenant.tenantId, doc.id],
        );
        const previous = (
          await seed.query(
            "SELECT title,source_text,encode(content_digest,'hex') AS digest FROM lab.document_versions WHERE tenant_id=$1 AND document_id=$2 AND version=$3",
            [tenant.tenantId, doc.id, doc.version],
          )
        ).rows[0];
        if (
          previous &&
          (previous.title !== doc.title ||
            previous.source_text !== doc.content ||
            previous.digest !== sha256(doc.content))
        )
          throw Error('Immutable document changed');
        if (!previous) {
          created = true;
          await seed.query(
            "INSERT INTO lab.document_versions(tenant_id,document_id,version,title,source_text,content_digest) VALUES($1,$2,$3,$4,$5,decode($6,'hex'))",
            [
              tenant.tenantId,
              doc.id,
              doc.version,
              doc.title,
              doc.content,
              sha256(doc.content),
            ],
          );
          for (const chunk of chunksFor(doc.id, doc.version, doc.content)) {
            await seed.query(
              "INSERT INTO lab.document_chunks(tenant_id,id,document_id,document_version,ordinal,content,content_digest) VALUES($1,$2,$3,$4,$5,$6,decode($7,'hex'))",
              [
                tenant.tenantId,
                chunk.id,
                doc.id,
                doc.version,
                chunk.ordinal,
                chunk.content,
                chunk.digest,
              ],
            );
            if (chunk.vector)
              await seed.query(
                'INSERT INTO lab.chunk_embeddings(tenant_id,chunk_id,profile_id,embedding) VALUES($1,$2,$3,$4::public.vector)',
                [
                  tenant.tenantId,
                  chunk.id,
                  retrievalProfile,
                  JSON.stringify(chunk.vector),
                ],
              );
          }
        }
        const stored = (
          await seed.query(
            "SELECT c.id,c.ordinal,c.content,encode(c.content_digest,'hex') AS digest,e.embedding::text AS vector FROM lab.document_chunks c LEFT JOIN lab.chunk_embeddings e ON e.tenant_id=c.tenant_id AND e.chunk_id=c.id AND e.profile_id=$4 WHERE c.tenant_id=$1 AND c.document_id=$2 AND c.document_version=$3 ORDER BY ordinal",
            [tenant.tenantId, doc.id, doc.version, retrievalProfile],
          )
        ).rows;
        const expected = chunksFor(doc.id, doc.version, doc.content);
        if (
          stored.length !== expected.length ||
          stored.some((row, i) => {
            const chunk = expected[i]!;
            return (
              row.id !== chunk.id ||
              row.ordinal !== i ||
              row.content !== chunk.content ||
              row.digest !== chunk.digest ||
              (chunk.vector
                ? !row.vector ||
                  (JSON.parse(row.vector) as number[]).some(
                    (n, j) => Math.abs(n - chunk.vector![j]!) > 0.000001,
                  )
                : row.vector !== null)
            );
          })
        )
          throw Error('Immutable chunks changed');
      }
      if (!existing) {
        created = true;
        await seed.query(
          "INSERT INTO lab.corpus_snapshots(tenant_id,id,version,manifest_digest,profile_id,chunking_profile) VALUES($1,$2,$3,decode($4,'hex'),$5,$6)",
          [
            tenant.tenantId,
            tenant.snapshotId,
            manifest.version,
            digest,
            retrievalProfile,
            chunkingProfile,
          ],
        );
        for (const doc of tenant.documents)
          await seed.query(
            'INSERT INTO lab.corpus_snapshot_documents(tenant_id,snapshot_id,document_id,document_version) VALUES($1,$2,$3,$4)',
            [tenant.tenantId, tenant.snapshotId, doc.id, doc.version],
          );
      }
      const members = (
        await seed.query(
          'SELECT document_id,document_version FROM lab.corpus_snapshot_documents WHERE tenant_id=$1 AND snapshot_id=$2 ORDER BY document_id,document_version',
          [tenant.tenantId, tenant.snapshotId],
        )
      ).rows;
      const wanted = tenant.documents
        .map((doc) => ({ document_id: doc.id, document_version: doc.version }))
        .sort((a, b) => a.document_id.localeCompare(b.document_id));
      if (JSON.stringify(members) !== JSON.stringify(wanted))
        throw Error('Immutable membership changed');
      const active = (
        await seed.query(
          'SELECT snapshot_id,profile_id,policy_version,provider_mode FROM lab.tenant_corpus_profiles WHERE tenant_id=$1',
          [tenant.tenantId],
        )
      ).rows[0];
      if (
        existing &&
        (!active ||
          active.snapshot_id !== tenant.snapshotId ||
          active.profile_id !== retrievalProfile ||
          (active.policy_version !== selectedPolicy &&
            !(
              active.policy_version === policyVersion &&
              selectedPolicy === 'bounded-agent-v1'
            )) ||
          active.provider_mode !== 'simulated')
      )
        throw Error('Corpus selection changed');
      if (existing && active.policy_version !== selectedPolicy)
        await seed.query(
          'UPDATE lab.tenant_corpus_profiles SET policy_version=$2 WHERE tenant_id=$1',
          [tenant.tenantId, selectedPolicy],
        );
      if (!existing)
        await seed.query(
          "INSERT INTO lab.tenant_corpus_profiles(tenant_id,snapshot_id,profile_id,policy_version,provider_mode) VALUES($1,$2,$3,$4,'simulated') ON CONFLICT(tenant_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,profile_id=excluded.profile_id,policy_version=excluded.policy_version,provider_mode=excluded.provider_mode",
          [
            tenant.tenantId,
            tenant.snapshotId,
            retrievalProfile,
            selectedPolicy,
          ],
        );
    }
    await seed.query('COMMIT');
    return {
      status: created ? 'created' : 'unchanged',
      snapshots: manifest.tenants.length,
    };
  } catch (error) {
    await seed.query('ROLLBACK').catch(() => {});
    if (
      error instanceof Error &&
      error.message === 'Knowledge seed role required'
    )
      throw error;
    throw Error('Knowledge provisioning failed');
  }
}
