import type { Pool } from 'pg';
import { z } from 'zod';
import {
  lexicalVector,
  retrievalCacheKey,
  retrievalProfile,
  policyVersion,
  type Evidence,
} from '@lab/knowledge';
const schema = z.strictObject({
  tenantId: z.uuid(),
  snapshotId: z.uuid(),
  profile: z.literal(retrievalProfile),
  policy: z.literal(policyVersion).default(policyVersion),
  query: z
    .string()
    .trim()
    .refine(
      (value) =>
        value.length > 0 &&
        Array.from(value).length <= 4000 &&
        !value.includes('\0') &&
        !/[\uD800-\uDFFF]/u.test(value),
    ),
});
export class KnowledgeRetrieval {
  private readonly cache = new Map<
    string,
    { expires: number; evidence: Evidence[] }
  >();
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  async search(input: unknown): Promise<Evidence[]> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw Error('Invalid retrieval request');
    const request = parsed.data,
      key = retrievalCacheKey(request),
      cached = this.cache.get(key);
    if (cached && cached.expires > performance.now())
      return cached.evidence.map((row) => ({ ...row }));
    this.cache.delete(key);
    const vector = lexicalVector(request.query),
      client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(
        "SET LOCAL ROLE lab_worker; SET LOCAL statement_timeout='1s'",
      );
      const scope = await client.query(
        'SELECT id FROM lab.corpus_snapshots WHERE tenant_id=$1 AND id=$2 AND profile_id=$3',
        [request.tenantId, request.snapshotId, request.profile],
      );
      if (scope.rowCount !== 1) throw Error('Unavailable retrieval scope');
      const rows = vector
        ? (
            await client.query<{
              id: string;
              document_id: string;
              document_version: string;
              content: string;
              score: number;
            }>(
              `WITH scoped AS MATERIALIZED (
        SELECT c.id,c.document_id,c.document_version,c.content,e.embedding
        FROM lab.corpus_snapshot_documents m JOIN lab.document_chunks c
          ON c.tenant_id=m.tenant_id AND c.document_id=m.document_id AND c.document_version=m.document_version
        JOIN lab.chunk_embeddings e ON e.tenant_id=c.tenant_id AND e.chunk_id=c.id AND e.profile_id=$3
        WHERE m.tenant_id=$1 AND m.snapshot_id=$2
      ) SELECT id,document_id,document_version,content,1-(embedding OPERATOR(public.<=>) $4::public.vector) AS score
        FROM scoped WHERE 1-(embedding OPERATOR(public.<=>) $4::public.vector)>=0.25
        ORDER BY score DESC,id ASC LIMIT 5`,
              [
                request.tenantId,
                request.snapshotId,
                request.profile,
                JSON.stringify(vector),
              ],
            )
          ).rows
        : [];
      await client.query('COMMIT');
      const evidence = rows.map((row) => ({
        tenantId: request.tenantId,
        snapshotId: request.snapshotId,
        documentId: row.document_id,
        documentVersion: row.document_version,
        chunkId: row.id,
        content: row.content,
        score: Math.min(1, Math.max(0, row.score)),
      }));
      if (this.cache.size >= 32)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: performance.now() + 1000, evidence });
      return evidence.map((row) => ({ ...row }));
    } catch {
      discard = true;
      await client.query('ROLLBACK').catch(() => {});
      throw Error('Retrieval unavailable');
    } finally {
      client.release(discard);
    }
  }
}
