import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const operation = 'tickets:replay:v1';
const identifier = z.uuid().transform((value) => value.toLowerCase());
const schema = z.strictObject({
  tenantId: identifier,
  principalId: identifier,
  ticketId: identifier,
  requestId: identifier,
  key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  body: z.strictObject({
    expectedGeneration: z.number().int().min(1).max(2147483646),
  }),
});
export interface ReplayReceipt {
  ticketId: string;
  generation: number;
  statusUrl: string;
}
export class TicketReplayError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'IDEMPOTENCY_CONFLICT'
      | 'REPLAY_CONFLICT'
      | 'DEPENDENCY_UNAVAILABLE',
  ) {
    super(code);
  }
}
export class TicketReplays {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  async replay(input: unknown): Promise<ReplayReceipt> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new TicketReplayError('INVALID_REQUEST');
    const { tenantId, principalId, ticketId, requestId, key, body } =
      parsed.data;
    const digest = createHash('sha256')
      .update(`${operation}\0`)
      .update(JSON.stringify(body))
      .digest();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new TicketReplayError('DEPENDENCY_UNAVAILABLE');
    }
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        "SET LOCAL ROLE lab_api; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '10s'",
      );
      const actor = await client.query<{ role: string }>(
        'SELECT role FROM lab.principals WHERE tenant_id=$1 AND id=$2 AND disabled_at IS NULL',
        [tenantId, principalId],
      );
      if (actor.rows[0]?.role !== 'operator')
        throw new TicketReplayError('FORBIDDEN');
      // Serialize all replay keys for this resource in the same ticket-first lock
      // order as admission and execution. Existing receipts precede lifecycle checks.
      const tickets = await client.query<{ current_generation: number }>(
        'SELECT current_generation FROM lab.tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenantId, ticketId],
      );
      if (!tickets.rows[0]) throw new TicketReplayError('NOT_FOUND');
      const previous = await client.query<{
        request_hash: Buffer;
        receipt: ReplayReceipt;
      }>(
        'SELECT request_hash,receipt FROM lab.idempotency_records WHERE tenant_id=$1 AND operation=$2 AND resource_scope=$3 AND key=$4',
        [tenantId, operation, ticketId, key],
      );
      if (previous.rows[0]) {
        if (!timingSafeEqual(previous.rows[0].request_hash, digest))
          throw new TicketReplayError('IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT');
        return previous.rows[0].receipt;
      }
      if (tickets.rows[0].current_generation !== body.expectedGeneration)
        throw new TicketReplayError('REPLAY_CONFLICT');
      // All lifecycle writers acquire the ticket lock first. Holding it makes
      // this read stable without granting the API UPDATE on execution history.
      const current = await client.query<{ status: string }>(
        'SELECT status FROM lab.ticket_executions WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3',
        [tenantId, ticketId, body.expectedGeneration],
      );
      if (current.rows[0]?.status !== 'failed')
        throw new TicketReplayError('REPLAY_CONFLICT');
      const generation = body.expectedGeneration + 1,
        eventId = randomUUID();
      const receipt: ReplayReceipt = {
        ticketId,
        generation,
        statusUrl: `/v1/tickets/${ticketId}`,
      };
      await client.query(
        "INSERT INTO lab.ticket_executions(tenant_id,ticket_id,generation,status,scheduling_reason,requested_by,correlation_id,scheduling_event_id) VALUES($1,$2,$3,'queued','replayed',$4,$5,$6)",
        [tenantId, ticketId, generation, principalId, requestId, eventId],
      );
      const time = await client.query<{ at: Date }>(
        'SELECT transaction_timestamp() AS at',
      );
      const payload = JSON.stringify({
        eventId,
        type: 'ticket.execution.requested',
        version: 1,
        occurredAt: time.rows[0]!.at.toISOString(),
        tenantId,
        ticketId,
        generation,
        correlationId: requestId,
        causationId: requestId,
        data: { reason: 'replayed' },
      });
      await client.query(
        'INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest) VALUES($1,$2,$3,$4,$5,1,$6,$7)',
        [
          eventId,
          tenantId,
          ticketId,
          generation,
          'ticket.execution.requested',
          payload,
          createHash('sha256').update(payload).digest(),
        ],
      );
      await client.query(
        'INSERT INTO lab.idempotency_records(tenant_id,operation,resource_scope,key,request_hash,ticket_id,generation,receipt) VALUES($1,$2,$3,$4,$5,$8,$6,$7)',
        [
          tenantId,
          operation,
          ticketId,
          key,
          digest,
          generation,
          receipt,
          ticketId,
        ],
      );
      await client.query(
        "INSERT INTO lab.audit_records(id,tenant_id,principal_id,ticket_id,generation,previous_generation,action,request_id) VALUES($1,$2,$3,$4,$5,$6,'ticket.replayed',$7)",
        [
          randomUUID(),
          tenantId,
          principalId,
          ticketId,
          generation,
          body.expectedGeneration,
          requestId,
        ],
      );
      await client.query(
        'UPDATE lab.tickets SET current_generation=$3,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2',
        [tenantId, ticketId, generation],
      );
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      discard = !(error instanceof TicketReplayError);
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      if (error instanceof TicketReplayError) throw error;
      // A committed replay may have lost its acknowledgement; only the same key
      // may safely determine whether its immutable receipt already exists.
      throw new TicketReplayError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
}
