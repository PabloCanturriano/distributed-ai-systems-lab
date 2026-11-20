import { TextDecoder } from 'node:util';
import { z } from 'zod';

export interface SchedulingRecord {
  topic: string;
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
}
export type QuarantineReason =
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_EVENT'
  | 'EVENT_TOO_LARGE'
  | 'KEY_MISMATCH'
  | 'UNKNOWN_TICKET'
  | 'TENANT_MISMATCH'
  | 'FUTURE_GENERATION'
  | 'UNKNOWN_EXECUTION'
  | 'REASON_MISMATCH'
  | 'EVENT_ID_COLLISION'
  | 'EXECUTION_NOT_QUEUED';
export interface SchedulingEvent {
  eventId: string;
  tenantId: string;
  ticketId: string;
  generation: number;
  reason: 'submitted' | 'replayed';
}
const identifier = z.uuid().transform((value) => value.toLowerCase());
const envelope = z.object({
  eventId: identifier,
  tenantId: identifier,
  ticketId: identifier,
  type: z.literal('ticket.execution.requested'),
  version: z.literal(1),
  generation: z.number().int().min(1).max(2147483647),
  occurredAt: z.iso.datetime(),
  correlationId: identifier,
  causationId: identifier,
  data: z.object({ reason: z.enum(['submitted', 'replayed']) }),
});
const source = z.object({
  topic: z.literal('tickets.execution-requested.v1'),
  partition: z.number().int().min(0).max(2147483647),
  offset: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .pipe(z.string().refine((value) => BigInt(value) <= 9223372036854775807n)),
  key: z.custom<Buffer>(Buffer.isBuffer).nullable(),
  value: z.custom<Buffer>(Buffer.isBuffer).nullable(),
});
export function validSource(record: SchedulingRecord): boolean {
  return source.safeParse(record).success;
}
export function parseSchedulingEvent(
  record: SchedulingRecord,
): SchedulingEvent | QuarantineReason {
  if (!record.value) return 'INVALID_ENVELOPE';
  if (record.value.length > 16384) return 'EVENT_TOO_LARGE';
  let body: unknown;
  const decoder = new TextDecoder('utf8', { fatal: true });
  try {
    body = JSON.parse(decoder.decode(record.value));
  } catch {
    return 'INVALID_ENVELOPE';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return 'INVALID_ENVELOPE';
  const identity = body as Record<string, unknown>;
  if (identity.type !== 'ticket.execution.requested' || identity.version !== 1)
    return 'UNSUPPORTED_EVENT';
  const parsed = envelope.safeParse(body);
  // Detailed validation errors can include raw event content; keep them private.
  if (!parsed.success) return 'INVALID_ENVELOPE';
  const event = parsed.data;
  try {
    if (
      !record.key ||
      record.key.length !== 36 ||
      decoder.decode(record.key).toLowerCase() !== event.ticketId
    )
      return 'KEY_MISMATCH';
  } catch {
    return 'KEY_MISMATCH';
  }
  return {
    eventId: event.eventId,
    tenantId: event.tenantId,
    ticketId: event.ticketId,
    generation: event.generation,
    reason: event.data.reason,
  };
}
