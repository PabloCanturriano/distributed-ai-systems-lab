import { validTraceParent } from '@lab/telemetry';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  parseSchedulingEvent,
  validSource,
  type QuarantineReason,
  type SchedulingRecord,
} from './scheduling-event';

const consumer = 'ticket-scheduler.v1';
export type AdmissionResult =
  | {
      disposition: 'scheduled' | 'duplicate' | 'duplicate-generation' | 'stale';
    }
  | { disposition: 'quarantined'; reason: QuarantineReason };
export class SchedulingAdmissionError extends Error {
  constructor(readonly code: 'INVALID_RECORD' | 'DEPENDENCY_UNAVAILABLE') {
    super(code);
    this.name = 'SchedulingAdmissionError';
  }
}
// Internal durable handoff only. The future broker adapter must acknowledge only
// after this promise resolves, and must preserve contiguous partition ordering.
export class SchedulingAdmissions {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  async admit(record: SchedulingRecord): Promise<AdmissionResult> {
    if (!record || !validSource(record))
      throw new SchedulingAdmissionError('INVALID_RECORD');
    const traceParent = validTraceParent(record.traceParent);
    const digest = createHash('sha256')
      .update(record.value ?? Buffer.alloc(0))
      .digest();
    const event = parseSchedulingEvent(record);
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new SchedulingAdmissionError('DEPENDENCY_UNAVAILABLE');
    }
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        "SET LOCAL ROLE lab_worker; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
      );
      const quarantine = async (
        reason: QuarantineReason,
      ): Promise<AdmissionResult> => {
        await client.query(
          'INSERT INTO lab.event_quarantine(consumer_name,topic,partition,"offset",payload_digest,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            consumer,
            record.topic,
            record.partition,
            record.offset,
            digest,
            reason,
          ],
        );
        const existing = await client.query<{ reason: QuarantineReason }>(
          'SELECT reason FROM lab.event_quarantine WHERE consumer_name=$1 AND topic=$2 AND partition=$3 AND "offset"=$4',
          [consumer, record.topic, record.partition, record.offset],
        );
        return { disposition: 'quarantined', reason: existing.rows[0]!.reason };
      };
      const action = async (): Promise<AdmissionResult> => {
        const previous = await client.query<{ reason: QuarantineReason }>(
          'SELECT reason FROM lab.event_quarantine WHERE consumer_name=$1 AND topic=$2 AND partition=$3 AND "offset"=$4',
          [consumer, record.topic, record.partition, record.offset],
        );
        if (previous.rows[0])
          return {
            disposition: 'quarantined',
            reason: previous.rows[0].reason,
          };
        if (typeof event === 'string') return quarantine(event);
        const ticket = (
          await client.query<{ tenant_id: string; current_generation: number }>(
            'SELECT tenant_id,current_generation FROM lab.tickets WHERE id=$1 FOR UPDATE',
            [event.ticketId],
          )
        ).rows[0];
        if (!ticket) return quarantine('UNKNOWN_TICKET');
        if (ticket.tenant_id !== event.tenantId)
          return quarantine('TENANT_MISMATCH');
        if (event.generation > ticket.current_generation)
          return quarantine('FUTURE_GENERATION');
        const execution = (
          await client.query<{ scheduling_reason: string; status: string }>(
            'SELECT scheduling_reason,status FROM lab.ticket_executions WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3',
            [event.tenantId, event.ticketId, event.generation],
          )
        ).rows[0];
        if (!execution) return quarantine('UNKNOWN_EXECUTION');
        if (execution.scheduling_reason !== event.reason)
          return quarantine('REASON_MISMATCH');
        const existing = (
          await client.query<{ payload_digest: Buffer }>(
            'SELECT payload_digest FROM lab.consumer_inbox WHERE consumer_name=$1 AND event_id=$2',
            [consumer, event.eventId],
          )
        ).rows[0];
        if (existing)
          return timingSafeEqual(existing.payload_digest, digest)
            ? { disposition: 'duplicate' }
            : quarantine('EVENT_ID_COLLISION');
        const hasJob =
          (
            await client.query(
              'SELECT id FROM lab.execution_jobs WHERE ticket_id=$1 AND generation=$2',
              [event.ticketId, event.generation],
            )
          ).rowCount !== 0;
        const disposition =
          event.generation < ticket.current_generation
            ? 'stale'
            : hasJob
              ? 'duplicate-generation'
              : 'scheduled';
        if (disposition === 'scheduled' && execution.status !== 'queued')
          return quarantine('EXECUTION_NOT_QUEUED');
        const inserted = await client.query(
          'INSERT INTO lab.consumer_inbox(consumer_name,event_id,payload_digest,tenant_id,ticket_id,generation,disposition) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (consumer_name,event_id) DO NOTHING RETURNING event_id',
          [
            consumer,
            event.eventId,
            digest,
            event.tenantId,
            event.ticketId,
            event.generation,
            disposition,
          ],
        );
        if (inserted.rowCount === 0) {
          const winner = (
            await client.query<{ payload_digest: Buffer }>(
              'SELECT payload_digest FROM lab.consumer_inbox WHERE consumer_name=$1 AND event_id=$2',
              [consumer, event.eventId],
            )
          ).rows[0];
          if (!winner)
            throw new SchedulingAdmissionError('DEPENDENCY_UNAVAILABLE');
          return timingSafeEqual(winner.payload_digest, digest)
            ? { disposition: 'duplicate' }
            : quarantine('EVENT_ID_COLLISION');
        }
        if (disposition === 'scheduled')
          await client.query(
            `INSERT INTO lab.execution_jobs(id,tenant_id,ticket_id,generation,consumer_name,source_event_id${traceParent ? ',trace_parent' : ''}) VALUES($1,$2,$3,$4,$5,$6${traceParent ? ',$7' : ''})`,
            [
              randomUUID(),
              event.tenantId,
              event.ticketId,
              event.generation,
              consumer,
              event.eventId,
              ...(traceParent ? [traceParent] : []),
            ],
          );
        return { disposition };
      };
      const result = await action();
      await client.query('COMMIT');
      return result;
    } catch {
      discard = true;
      await client.query('ROLLBACK').catch(() => {});
      throw new SchedulingAdmissionError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
}
