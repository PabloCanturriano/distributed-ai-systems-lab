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
export interface TicketStatus {
  ticketId: string;
  generation: number;
  status: 'queued' | 'processing';
  createdAt: string;
  updatedAt: string;
  result: null;
  failure: null;
}
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
      }>(
        `SELECT t.id,t.current_generation,t.created_at,e.status,e.updated_at FROM lab.tickets t
         JOIN lab.ticket_executions e ON e.tenant_id=t.tenant_id AND e.ticket_id=t.id AND e.generation=t.current_generation
         WHERE t.tenant_id=$1 AND t.id=$2`,
        [tenantId, ticketId],
      );
      const row = result.rows[0];
      if (!row) throw new TicketReadError('NOT_FOUND');
      // Result/failure persistence belongs to a later slice. Never fabricate a
      // completed/failed representation from a manually altered lifecycle row.
      if (row.status !== 'queued' && row.status !== 'processing')
        throw new TicketReadError('DEPENDENCY_UNAVAILABLE');
      const status: TicketStatus = {
        ticketId: row.id,
        generation: row.current_generation,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        result: null,
        failure: null,
      };
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
