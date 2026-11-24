import { validTraceParent } from '@lab/telemetry';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const operation = 'tickets:create:v1';
const scope = 'tickets';
const inputSchema = z.strictObject({
  tenantId: z.uuid().transform((value) => value.toLowerCase()),
  principalId: z.uuid().transform((value) => value.toLowerCase()),
  requestId: z.uuid().transform((value) => value.toLowerCase()),
  traceParent: z.unknown().optional().transform(validTraceParent),
  key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  body: z.strictObject({
    message: z
      .string()
      .trim()
      .refine(
        (value) =>
          value.length > 0 &&
          Array.from(value).length <= 4000 &&
          !/[\uD800-\uDFFF]/u.test(value) &&
          !value.includes('\0'),
      ),
  }),
});

export interface TicketReceipt {
  ticketId: string;
  generation: 1;
  statusUrl: string;
}

export class TicketSubmissionError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'FORBIDDEN'
      | 'IDEMPOTENCY_CONFLICT'
      | 'DEPENDENCY_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'TicketSubmissionError';
  }
}

// Internal boundary only. Tenant/principal context must come from server authentication,
// never directly from an HTTP body/header.
export class TicketSubmissions {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async submit(input: unknown): Promise<TicketReceipt> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new TicketSubmissionError('INVALID_REQUEST');
    const {
      tenantId,
      principalId,
      requestId,
      key,
      body: { message },
    } = parsed.data;
    const hash = createHash('sha256')
      .update(`${operation}\0`)
      .update(JSON.stringify({ message }))
      .digest();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new TicketSubmissionError('DEPENDENCY_UNAVAILABLE');
    }
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        "SET LOCAL ROLE lab_api; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '10s'",
      );
      const identity = await client.query<{ role: string }>(
        'SELECT role FROM lab.principals WHERE tenant_id=$1 AND id=$2 AND disabled_at IS NULL',
        [tenantId, principalId],
      );
      if (!['requester', 'operator'].includes(identity.rows[0]?.role ?? ''))
        throw new TicketSubmissionError('FORBIDDEN');
      const ticketId = randomUUID();
      const eventId = randomUUID();
      const receipt: TicketReceipt = {
        ticketId,
        generation: 1,
        statusUrl: `/v1/tickets/${ticketId}`,
      };
      // Reserve uniqueness before writing business rows. The deferred FK forbids
      // committing a receipt without its execution; rollback releases this reservation.
      const reservation = await client.query(
        'INSERT INTO lab.idempotency_records(tenant_id,operation,resource_scope,key,request_hash,ticket_id,generation,receipt) VALUES($1,$2,$3,$4,$5,$6,1,$7) ON CONFLICT (tenant_id,operation,resource_scope,key) DO NOTHING RETURNING ticket_id',
        [tenantId, operation, scope, key, hash, ticketId, receipt],
      );
      if (reservation.rowCount === 0) {
        // A new READ COMMITTED statement sees the concurrent winner after waiting.
        const previous = await client.query<{
          request_hash: Buffer;
          receipt: TicketReceipt;
        }>(
          'SELECT request_hash,receipt FROM lab.idempotency_records WHERE tenant_id=$1 AND operation=$2 AND resource_scope=$3 AND key=$4',
          [tenantId, operation, scope, key],
        );
        const row = previous.rows[0];
        if (!row) throw new TicketSubmissionError('DEPENDENCY_UNAVAILABLE');
        if (!timingSafeEqual(hash, row.request_hash))
          throw new TicketSubmissionError('IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT');
        return row.receipt;
      }
      await client.query(
        'INSERT INTO lab.tickets(id,tenant_id,created_by,message,current_generation) VALUES($1,$2,$3,$4,1)',
        [ticketId, tenantId, principalId, message],
      );
      await client.query(
        "INSERT INTO lab.ticket_executions(tenant_id,ticket_id,generation,status,scheduling_reason,requested_by,correlation_id,scheduling_event_id) VALUES($1,$2,1,'queued','submitted',$3,$4,$5)",
        [tenantId, ticketId, principalId, requestId, eventId],
      );
      const time = await client.query<{ occurred_at: Date }>(
        'SELECT transaction_timestamp() AS occurred_at',
      );
      const payload = JSON.stringify({
        eventId,
        type: 'ticket.execution.requested',
        version: 1,
        occurredAt: time.rows[0]!.occurred_at.toISOString(),
        tenantId,
        ticketId,
        generation: 1,
        correlationId: requestId,
        causationId: requestId,
        data: { reason: 'submitted' },
      });
      await client.query(
        `INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest${parsed.data.traceParent ? ',trace_parent' : ''}) VALUES($1,$2,$3,1,$4,1,$5,$6${parsed.data.traceParent ? ',$7' : ''})`,
        [
          eventId,
          tenantId,
          ticketId,
          'ticket.execution.requested',
          payload,
          createHash('sha256').update(payload).digest(),
          ...(parsed.data.traceParent ? [parsed.data.traceParent] : []),
        ],
      );
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      discard = !(error instanceof TicketSubmissionError);
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      if (error instanceof TicketSubmissionError) throw error;
      // A lost COMMIT acknowledgement is ambiguous. Report failure safely; retry
      // with the same key observes the receipt if the transaction really committed.
      throw new TicketSubmissionError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
}
