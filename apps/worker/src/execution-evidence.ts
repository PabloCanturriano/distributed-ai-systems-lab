import type { Pool, PoolClient } from 'pg';
import type { Evidence } from '@lab/knowledge';
import type { ExecutionClaim } from './execution-ownership';
export interface ExecutionContext {
  tenantId: string;
  snapshotId: string;
  profile: 'lexical-hash-v1';
  policy: 'extractive-simulated-v1' | 'bounded-agent-v1';
  message: string;
}
export class ExecutionEvidence {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  private async transaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN');
      await c.query(
        "SET LOCAL ROLE lab_worker; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'",
      );
      const result = await action(c);
      await c.query('COMMIT');
      return result;
    } catch {
      discard = true;
      await c.query('ROLLBACK').catch(() => {});
      throw Error('Execution evidence unavailable');
    } finally {
      c.release(discard);
    }
  }
  load(claim: ExecutionClaim): Promise<ExecutionContext | null> {
    return this.transaction(async (c) => {
      const row = (
        await c.query(
          `SELECT t.message,x.snapshot_id,x.profile_id,x.policy_version,x.provider_mode FROM lab.tickets t
        JOIN lab.execution_jobs j ON j.tenant_id=t.tenant_id AND j.ticket_id=t.id AND j.generation=t.current_generation
        LEFT JOIN lab.execution_configurations x ON x.tenant_id=j.tenant_id AND x.ticket_id=j.ticket_id AND x.generation=j.generation
        WHERE t.tenant_id=$1 AND t.id=$2 AND j.generation=$3 AND j.id=$4 AND j.attempt_id=$5 AND j.status='running' AND j.lease_expires_at>clock_timestamp()`,
          [
            claim.tenantId,
            claim.ticketId,
            claim.generation,
            claim.jobId,
            claim.attemptId,
          ],
        )
      ).rows[0];
      if (!row) throw Error();
      if (row.snapshot_id === null) return null; // Jobs accepted before RAG retain their original abstention mode.
      if (
        row.profile_id !== 'lexical-hash-v1' ||
        !['extractive-simulated-v1', 'bounded-agent-v1'].includes(
          row.policy_version,
        ) ||
        row.provider_mode !== 'simulated'
      )
        throw Error();
      return {
        tenantId: claim.tenantId,
        snapshotId: row.snapshot_id,
        profile: row.profile_id,
        policy: row.policy_version,
        message: row.message,
      };
    });
  }
  record(
    claim: ExecutionClaim,
    context: ExecutionContext,
    evidence: Evidence[],
  ): Promise<void> {
    if (
      evidence.length > 5 ||
      evidence.some(
        (row) =>
          row.tenantId !== claim.tenantId ||
          row.snapshotId !== context.snapshotId ||
          Buffer.byteLength(row.content) > 2048,
      )
    )
      return Promise.reject(Error('Invalid execution evidence'));
    return this.transaction(async (c) => {
      await c.query(
        'SELECT id FROM lab.tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [claim.tenantId, claim.ticketId],
      );
      await c.query(
        'SELECT id FROM lab.execution_jobs WHERE id=$1 FOR UPDATE',
        [claim.jobId],
      );
      const current = await c.query(
        `SELECT j.id FROM lab.execution_jobs j JOIN lab.tickets t ON t.tenant_id=j.tenant_id AND t.id=j.ticket_id
        JOIN lab.execution_configurations x ON x.tenant_id=j.tenant_id AND x.ticket_id=j.ticket_id AND x.generation=j.generation
        WHERE j.id=$1 AND j.tenant_id=$2 AND j.ticket_id=$3 AND j.generation=$4 AND t.current_generation=j.generation AND j.attempt_id=$5
          AND j.status='running' AND j.lease_expires_at>clock_timestamp() AND x.snapshot_id=$6 AND x.profile_id=$7`,
        [
          claim.jobId,
          claim.tenantId,
          claim.ticketId,
          claim.generation,
          claim.attemptId,
          context.snapshotId,
          context.profile,
        ],
      );
      if (current.rowCount !== 1) throw Error();
      await insertOwnedEvidence(c, claim, context, evidence);
    });
  }
}

// Caller must hold the ticket/job locks and verify current generation, attempt and lease.
export async function insertOwnedEvidence(
  c: PoolClient,
  claim: Pick<
    ExecutionClaim,
    | 'tenantId'
    | 'ticketId'
    | 'generation'
    | 'jobId'
    | 'attemptId'
    | 'attemptNumber'
  >,
  context: Pick<ExecutionContext, 'snapshotId' | 'profile'>,
  evidence: Evidence[],
): Promise<void> {
  for (const [i, row] of evidence.entries()) {
    const inserted = await c.query(
      `INSERT INTO lab.execution_evidence(tenant_id,ticket_id,generation,job_id,attempt_id,attempt_number,position,snapshot_id,profile_id,document_id,document_version,chunk_id)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,c.document_id,c.document_version,c.id FROM lab.document_chunks c
            WHERE c.tenant_id=$1 AND c.id=$10 AND c.document_id=$11 AND c.document_version=$12 AND c.content=$13 RETURNING chunk_id`,
      [
        claim.tenantId,
        claim.ticketId,
        claim.generation,
        claim.jobId,
        claim.attemptId,
        claim.attemptNumber,
        i + 1,
        context.snapshotId,
        context.profile,
        row.chunkId,
        row.documentId,
        row.documentVersion,
        row.content,
      ],
    );
    if (inserted.rowCount !== 1) throw Error();
  }
}
