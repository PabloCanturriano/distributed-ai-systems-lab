import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
const id = z.uuid().transform((v) => v.toLowerCase());
const source = z.strictObject({
  partition: z.number().int().min(0).max(2147483647),
  offset: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const repairSchema = z.strictObject({
  environmentId: id,
  tenantId: id,
  ticketId: id,
  generation: z.number().int().min(1).max(2147483647),
  expectedEventId: id,
  source,
  reason: z.enum(['SCHEMA_CORRECTED', 'SOURCE_CORRECTED', 'DELIVERY_RECOVERY']),
  key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  requestId: id,
});
export type RepairInput = z.infer<typeof repairSchema>;
export interface RepairReceipt {
  repairId: string;
  ticketId: string;
  generation: number;
  previousEventId: string;
  newEventId: string;
}
export class RepairError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'ENVIRONMENT_CONFLICT'
      | 'NOT_FOUND'
      | 'REPAIR_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'DEPENDENCY_UNAVAILABLE',
  ) {
    super(code);
  }
}
const operation = 'tickets:delivery-repair:v1';
type Execution = {
  status: string;
  scheduling_reason: 'submitted' | 'replayed';
  correlation_id: string;
  scheduling_event_id: string;
};
export class DeliveryRepairs {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  private async transaction<T>(
    readonly: boolean,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new RepairError('DEPENDENCY_UNAVAILABLE');
    }
    let discard = false;
    try {
      await client.query(
        readonly ? 'BEGIN READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED',
      );
      await client.query(
        "SET LOCAL ROLE lab_operations; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
      );
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      discard = !(error instanceof RepairError);
      await client.query('ROLLBACK').catch(() => {
        discard = true;
      });
      if (error instanceof RepairError) throw error;
      throw new RepairError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
  async inspect() {
    return this.transaction(true, async (c) => {
      const environment = (
        await c.query<{ id: string }>(
          'SELECT id FROM lab.environment_identity WHERE singleton',
        )
      ).rows[0];
      if (!environment) throw new RepairError('ENVIRONMENT_CONFLICT');
      const quarantine = (
        await c.query(
          'SELECT consumer_name,topic,partition,"offset"::text,encode(payload_digest,\'hex\') AS digest,reason,created_at FROM lab.event_quarantine ORDER BY created_at DESC,consumer_name,topic,partition,"offset" LIMIT 100',
        )
      ).rows;
      const queued = (
        await c.query(
          "SELECT t.tenant_id,t.id AS ticket_id,t.current_generation AS generation,e.scheduling_event_id,e.scheduling_reason FROM lab.tickets t JOIN lab.ticket_executions e ON e.tenant_id=t.tenant_id AND e.ticket_id=t.id AND e.generation=t.current_generation WHERE e.status='queued' AND NOT EXISTS(SELECT 1 FROM lab.execution_jobs j WHERE j.tenant_id=e.tenant_id AND j.ticket_id=e.ticket_id AND j.generation=e.generation) ORDER BY t.tenant_id,t.id LIMIT 100",
        )
      ).rows;
      return { environmentId: environment.id, quarantine, queued };
    });
  }
  private parse(input: unknown) {
    const p = repairSchema.safeParse(input);
    if (!p.success) throw new RepairError('INVALID_REQUEST');
    return p.data;
  }
  private async environment(c: PoolClient, input: RepairInput) {
    const rows = await c.query(
      'SELECT id FROM lab.environment_identity WHERE singleton AND id=$1',
      [input.environmentId],
    );
    if (rows.rowCount !== 1) throw new RepairError('ENVIRONMENT_CONFLICT');
  }
  private async eligible(
    c: PoolClient,
    input: RepairInput,
    locked: boolean,
  ): Promise<Execution> {
    const ticket = (
      await c.query<{ current_generation: number }>(
        `SELECT current_generation FROM lab.tickets WHERE tenant_id=$1 AND id=$2${locked ? ' FOR UPDATE' : ''}`,
        [input.tenantId, input.ticketId],
      )
    ).rows[0];
    if (!ticket) throw new RepairError('NOT_FOUND');
    if (ticket.current_generation !== input.generation)
      throw new RepairError('REPAIR_CONFLICT');
    const execution = (
      await c.query<Execution>(
        'SELECT status,scheduling_reason,correlation_id,scheduling_event_id FROM lab.ticket_executions WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3',
        [input.tenantId, input.ticketId, input.generation],
      )
    ).rows[0];
    if (
      !execution ||
      execution.status !== 'queued' ||
      execution.scheduling_event_id !== input.expectedEventId
    )
      throw new RepairError('REPAIR_CONFLICT');
    if (
      (
        await c.query(
          'SELECT id FROM lab.execution_jobs WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3',
          [input.tenantId, input.ticketId, input.generation],
        )
      ).rowCount !== 0
    )
      throw new RepairError('REPAIR_CONFLICT');
    const record = (
      await c.query<{ payload_digest: Buffer }>(
        "SELECT payload_digest FROM lab.event_quarantine WHERE consumer_name='ticket-scheduler.v1' AND topic='tickets.execution-requested.v1' AND partition=$1 AND \"offset\"=$2",
        [input.source.partition, input.source.offset],
      )
    ).rows[0];
    if (
      !record ||
      !timingSafeEqual(
        record.payload_digest,
        Buffer.from(input.source.digest, 'hex'),
      )
    )
      throw new RepairError('REPAIR_CONFLICT');
    return execution;
  }
  async plan(input: unknown) {
    const value = this.parse(input);
    return this.transaction(true, async (c) => {
      await this.environment(c, value);
      await this.eligible(c, value, false);
      return value;
    });
  }
  async repair(input: unknown): Promise<RepairReceipt> {
    const value = this.parse(input),
      { requestId, ...expected } = value;
    const hash = createHash('sha256')
      .update(`${operation}\0`)
      .update(JSON.stringify(expected))
      .digest();
    return this.transaction(false, async (c) => {
      await this.environment(c, value);
      // A ticket-first lock serializes repair with admission, replay and ownership.
      const ticket = (
        await c.query(
          'SELECT id FROM lab.tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [value.tenantId, value.ticketId],
        )
      ).rows[0];
      if (!ticket) throw new RepairError('NOT_FOUND');
      const previous = (
        await c.query<{
          request_hash: Buffer;
          id: string;
          ticket_id: string;
          generation: number;
          previous_event_id: string;
          new_event_id: string;
        }>(
          'SELECT i.request_hash,r.id,r.ticket_id,r.generation,r.previous_event_id,r.new_event_id FROM lab.idempotency_records i LEFT JOIN lab.delivery_repairs r ON r.tenant_id=i.tenant_id AND r.operation=i.operation AND r.resource_scope=i.resource_scope AND r.key=i.key WHERE i.tenant_id=$1 AND i.operation=$2 AND i.resource_scope=$3 AND i.key=$4',
          [value.tenantId, operation, value.ticketId, value.key],
        )
      ).rows[0];
      if (previous) {
        if (!timingSafeEqual(previous.request_hash, hash))
          throw new RepairError('IDEMPOTENCY_CONFLICT');
        if (!previous.id) throw new RepairError('DEPENDENCY_UNAVAILABLE');
        return {
          repairId: previous.id,
          ticketId: previous.ticket_id,
          generation: previous.generation,
          previousEventId: previous.previous_event_id,
          newEventId: previous.new_event_id,
        };
      }
      const execution = await this.eligible(c, value, false),
        eventId = randomUUID(),
        repairId = randomUUID();
      const time = (
        await c.query<{ at: Date; actor: string }>(
          'SELECT transaction_timestamp() AS at,session_user::text AS actor',
        )
      ).rows[0]!;
      const payload = JSON.stringify({
        eventId,
        type: 'ticket.execution.requested',
        version: 1,
        occurredAt: time.at.toISOString(),
        tenantId: value.tenantId,
        ticketId: value.ticketId,
        generation: value.generation,
        correlationId: execution.correlation_id,
        causationId: requestId,
        data: { reason: execution.scheduling_reason },
      });
      await c.query(
        'INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest) VALUES($1,$2,$3,$4,$5,1,$6,$7)',
        [
          eventId,
          value.tenantId,
          value.ticketId,
          value.generation,
          'ticket.execution.requested',
          payload,
          createHash('sha256').update(payload).digest(),
        ],
      );
      const receipt = {
        ticketId: value.ticketId,
        generation: value.generation,
        statusUrl: `/v1/tickets/${value.ticketId}`,
      };
      await c.query(
        'INSERT INTO lab.idempotency_records(tenant_id,operation,resource_scope,key,request_hash,ticket_id,generation,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          value.tenantId,
          operation,
          value.ticketId,
          value.key,
          hash,
          value.ticketId,
          value.generation,
          receipt,
        ],
      );
      await c.query(
        "INSERT INTO lab.delivery_repairs(id,tenant_id,ticket_id,generation,operation,resource_scope,key,previous_event_id,new_event_id,source_consumer,source_topic,source_partition,source_offset,source_digest,reason,actor_database_role,request_id,environment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ticket-scheduler.v1','tickets.execution-requested.v1',$10,$11,$12,$13,$14,$15,$16)",
        [
          repairId,
          value.tenantId,
          value.ticketId,
          value.generation,
          operation,
          value.ticketId,
          value.key,
          value.expectedEventId,
          eventId,
          value.source.partition,
          value.source.offset,
          Buffer.from(value.source.digest, 'hex'),
          value.reason,
          time.actor,
          requestId,
          value.environmentId,
        ],
      );
      await c.query(
        'UPDATE lab.ticket_executions SET scheduling_event_id=$4 WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3',
        [value.tenantId, value.ticketId, value.generation, eventId],
      );
      return {
        repairId,
        ticketId: value.ticketId,
        generation: value.generation,
        previousEventId: value.expectedEventId,
        newEventId: eventId,
      };
    });
  }
}
