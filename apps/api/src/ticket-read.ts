import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export class TicketReadError extends Error {
  constructor(
    readonly code:
      'INVALID_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'DEPENDENCY_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'TicketReadError';
  }
}
const schema = z.strictObject({
  tenantId: z.uuid(),
  principalId: z.uuid(),
  ticketId: z.uuid(),
});
interface TicketStatusBase {
  ticketId: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
}
export type TicketStatus = TicketStatusBase &
  (
    | { status: 'queued' | 'processing'; result: null; failure: null }
    | {
        status: 'completed';
        result: {
          outcome: 'insufficient_evidence';
          answer: string;
          citations: [];
          execution: {
            providerMode: 'simulated';
            attemptCount: number;
            toolCalls: [];
          };
        };
        failure: null;
      }
    | {
        status: 'failed';
        result: null;
        failure: {
          code: 'EXECUTION_FAILED' | 'ATTEMPTS_EXHAUSTED';
          message: string;
        };
      }
  );
export class TicketReads {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  async get(input: unknown): Promise<TicketStatus> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new TicketReadError('INVALID_REQUEST');
    const { tenantId, principalId, ticketId } = parsed.data;
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new TicketReadError('DEPENDENCY_UNAVAILABLE');
    }
    let discard = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL ROLE lab_api');
      const principal = await client.query<{ role: string }>(
        'SELECT role FROM lab.principals WHERE tenant_id=$1 AND id=$2 AND disabled_at IS NULL',
        [tenantId, principalId],
      );
      if (
        !['reader', 'requester', 'operator'].includes(
          principal.rows[0]?.role ?? '',
        )
      )
        throw new TicketReadError('FORBIDDEN');
      // One scoped join reads a coherent current generation; no caller-selected tenant.
      const result = await client.query<{
        id: string;
        current_generation: number;
        status: string;
        created_at: Date;
        updated_at: Date;
        job_status: string | null;
        job_attempt_count: number | null;
        failure_code: string | null;
        outcome: string | null;
        answer: string | null;
        provider_mode: string | null;
        result_attempt_count: number | null;
      }>(
        `SELECT t.id,t.current_generation,t.created_at,e.status,e.updated_at,
         j.status AS job_status,j.attempt_count AS job_attempt_count,j.failure_code,
         r.outcome,r.answer,r.provider_mode,r.attempt_count AS result_attempt_count FROM lab.tickets t
         JOIN lab.ticket_executions e ON e.tenant_id=t.tenant_id AND e.ticket_id=t.id AND e.generation=t.current_generation
         LEFT JOIN lab.execution_jobs j ON j.tenant_id=e.tenant_id AND j.ticket_id=e.ticket_id AND j.generation=e.generation
         LEFT JOIN lab.execution_results r ON r.tenant_id=e.tenant_id AND r.ticket_id=e.ticket_id AND r.generation=e.generation
         WHERE t.tenant_id=$1 AND t.id=$2`,
        [tenantId, ticketId],
      );
      const row = result.rows[0];
      if (!row) throw new TicketReadError('NOT_FOUND');
      const base: TicketStatusBase = {
        ticketId: row.id,
        generation: row.current_generation,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
      let status: TicketStatus;
      if (
        (row.status === 'queued' || row.status === 'processing') &&
        row.outcome === null
      ) {
        status = { ...base, status: row.status, result: null, failure: null };
      } else if (
        row.status === 'completed' &&
        row.job_status === 'completed' &&
        row.outcome === 'insufficient_evidence' &&
        row.provider_mode === 'simulated' &&
        typeof row.answer === 'string' &&
        row.answer.trim().length > 0 &&
        Buffer.byteLength(row.answer, 'utf8') <= 8192 &&
        row.result_attempt_count !== null &&
        row.result_attempt_count > 0 &&
        row.result_attempt_count === row.job_attempt_count
      ) {
        status = {
          ...base,
          status: 'completed',
          failure: null,
          result: {
            outcome: 'insufficient_evidence',
            answer: row.answer,
            citations: [],
            execution: {
              providerMode: 'simulated',
              attemptCount: row.result_attempt_count,
              toolCalls: [],
            },
          },
        };
      } else if (
        row.status === 'failed' &&
        row.job_status === 'failed' &&
        row.outcome === null &&
        (row.failure_code === 'EXECUTION_FAILED' ||
          row.failure_code === 'ATTEMPTS_EXHAUSTED')
      ) {
        status = {
          ...base,
          status: 'failed',
          result: null,
          failure: {
            code: row.failure_code,
            message:
              row.failure_code === 'EXECUTION_FAILED'
                ? 'Execution failed.'
                : 'Execution attempts exhausted.',
          },
        };
      } else {
        // Never fabricate terminal output from a manually altered lifecycle row.
        throw new TicketReadError('DEPENDENCY_UNAVAILABLE');
      }
      await client.query('COMMIT');
      return status;
    } catch (error) {
      discard = !(error instanceof TicketReadError);
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      if (error instanceof TicketReadError) throw error;
      throw new TicketReadError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
}
