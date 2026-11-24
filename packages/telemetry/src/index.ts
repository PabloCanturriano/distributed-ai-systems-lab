import type { Writable } from 'node:stream';
import { ROOT_CONTEXT, trace, SpanKind, type Span } from '@opentelemetry/api';
import {
  TracerProvider,
  type SpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';

export type Stage =
  | 'http.submit'
  | 'http.replay'
  | 'http.read'
  | 'outbox.publish'
  | 'consumer.admit'
  | 'execution.run';
export type Outcome =
  | 'accepted'
  | 'observed'
  | 'completed'
  | 'scheduled'
  | 'duplicate'
  | 'duplicate-generation'
  | 'stale'
  | 'quarantined'
  | 'retryable'
  | 'failed'
  | 'interrupted';
export interface Metadata {
  ticketId?: string;
  eventId?: string;
  requestId?: string;
  attemptId?: string;
  generation?: number;
}
export interface TraceRecord {
  event: 'trace_span';
  service: 'lab-api' | 'lab-worker';
  role: 'api' | 'relay' | 'consumer' | 'executor';
  stage: Stage;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  outcome: Outcome;
  durationMs: number;
  ticketId?: string;
  eventId?: string;
  requestId?: string;
  attemptId?: string;
  generation?: number;
}
export interface TraceOperation {
  readonly traceParent: string | undefined;
  readonly traceId: string | undefined;
  end(outcome: Outcome, metadata?: Metadata): void;
}
export interface Telemetry {
  start(stage: Stage, parent?: unknown): TraceOperation;
  shutdown(): Promise<void>;
}
const stages = new Set<Stage>([
  'http.submit',
  'http.replay',
  'http.read',
  'outbox.publish',
  'consumer.admit',
  'execution.run',
]);
const outcomes = new Set<Outcome>([
  'accepted',
  'observed',
  'completed',
  'scheduled',
  'duplicate',
  'duplicate-generation',
  'stale',
  'quarantined',
  'retryable',
  'failed',
  'interrupted',
]);
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function validTraceParent(value: unknown): string | undefined {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 55) return undefined;
    value = value.toString('utf8');
  }
  if (
    typeof value !== 'string' ||
    value.length !== 55 ||
    !/^00-[a-f0-9]{32}-[a-f0-9]{16}-(00|01)$/.test(value) ||
    value.slice(3, 35) === '0'.repeat(32) ||
    value.slice(36, 52) === '0'.repeat(16)
  )
    return undefined;
  return value;
}
export const noTelemetry: Telemetry = {
  start: () => ({ traceParent: undefined, traceId: undefined, end: () => {} }),
  shutdown: async () => {},
};
export function createStreamSink(
  stream: Pick<Writable, 'destroyed' | 'writableLength' | 'write'>,
): (record: TraceRecord) => boolean {
  return (record) => {
    // Bound telemetry's contribution to a backed-up Docker stdout pipe. No
    // exporter queue, payload capture, network I/O or timer exists in this phase.
    if (stream.destroyed || stream.writableLength > 32768) return false;
    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) > 2048) return false;
    stream.write(line, () => {});
    return true;
  };
}
export const stdoutSink = createStreamSink(process.stdout);
export function createTelemetry(
  service: TraceRecord['service'],
  role: TraceRecord['role'],
  sink: (record: TraceRecord) => boolean = stdoutSink,
): Telemetry {
  const processor: SpanProcessor = {
    onStart: () => {},
    forceFlush: async () => {},
    shutdown: async () => {},
    onEnd: (span: ReadableSpan) => {
      try {
        const stage = span.name as Stage,
          outcome = span.attributes.outcome as Outcome;
        if (!stages.has(stage) || !outcomes.has(outcome)) return;
        const context = span.spanContext();
        const record: TraceRecord = {
          event: 'trace_span',
          service,
          role,
          stage,
          traceId: context.traceId,
          spanId: context.spanId,
          outcome,
          durationMs: Math.max(
            0,
            Math.round(
              (span.duration[0] * 1000 + span.duration[1] / 1000000) * 1000,
            ) / 1000,
          ),
        };
        if (span.parentSpanContext)
          record.parentSpanId = span.parentSpanContext.spanId;
        for (const key of [
          'ticketId',
          'eventId',
          'requestId',
          'attemptId',
        ] as const) {
          const value = span.attributes[key];
          if (typeof value === 'string' && uuid.test(value))
            record[key] = value.toLowerCase();
        }
        const generation = span.attributes.generation;
        if (
          typeof generation === 'number' &&
          Number.isInteger(generation) &&
          generation > 0 &&
          generation <= 2147483647
        )
          record.generation = generation;
        sink(record);
      } catch {
        /* Observability never determines a business outcome. */
      }
    },
  };
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      'service.name': service,
      'worker.role': role,
    }),
    spanProcessors: [processor],
    spanLimits: {
      attributeCountLimit: 6,
      attributeValueLengthLimit: 64,
      eventCountLimit: 0,
      linkCountLimit: 0,
    },
  });
  const tracer = provider.getTracer('@lab/telemetry', '1');
  return {
    start: (stage, parent) => {
      try {
        if (!stages.has(stage)) return noTelemetry.start(stage);
        const value = validTraceParent(parent);
        const context = value
          ? trace.setSpanContext(ROOT_CONTEXT, {
              traceId: value.slice(3, 35),
              spanId: value.slice(36, 52),
              traceFlags: Number.parseInt(value.slice(53), 16),
              isRemote: true,
            })
          : ROOT_CONTEXT;
        const span: Span = tracer.startSpan(
            stage,
            {
              kind: stage.startsWith('http.')
                ? SpanKind.SERVER
                : stage === 'outbox.publish'
                  ? SpanKind.PRODUCER
                  : stage === 'consumer.admit'
                    ? SpanKind.CONSUMER
                    : SpanKind.INTERNAL,
            },
            context,
          ),
          sc = span.spanContext();
        let ended = false;
        return {
          traceId: sc.traceId,
          traceParent: `00-${sc.traceId}-${sc.spanId}-01`,
          end: (outcome, metadata = {}) => {
            if (ended) return;
            ended = true;
            try {
              span.setAttribute(
                'outcome',
                outcomes.has(outcome) ? outcome : 'failed',
              );
              for (const key of [
                'ticketId',
                'eventId',
                'requestId',
                'attemptId',
              ] as const) {
                const v = metadata[key];
                if (typeof v === 'string' && uuid.test(v))
                  span.setAttribute(key, v);
              }
              if (
                Number.isInteger(metadata.generation) &&
                metadata.generation! > 0 &&
                metadata.generation! <= 2147483647
              )
                span.setAttribute('generation', metadata.generation!);
              span.end();
            } catch {
              /* Export/SDK errors cannot fail a ticket. */
            }
          },
        };
      } catch {
        return noTelemetry.start(stage);
      }
    },
    shutdown: async () => {
      try {
        await provider.shutdown();
      } catch {}
    },
  };
}
// Install only for a live default stdout sink, rather than changing test streams.
export function localTelemetry(
  service: TraceRecord['service'],
  role: TraceRecord['role'],
): Telemetry {
  process.stdout.on('error', () => {});
  try {
    return createTelemetry(service, role);
  } catch {
    return noTelemetry;
  }
}
