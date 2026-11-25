import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { boundedProcessor } from './export';
export { boundedProcessor } from './export';
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
  | 'execution.run'
  | 'transaction.submit'
  | 'transaction.replay'
  | 'job.claim'
  | 'result.persist';
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
  start(stage: Stage, parent?: unknown, startedAt?: Date): TraceOperation;
  increment?(
    operation:
      | 'dependency.postgres'
      | 'dependency.redis'
      | 'dependency.kafka'
      | 'lease.renew'
      | 'lease.complete'
      | 'lease.retry'
      | 'lease.fail',
  ): void;
  snapshot?(
    rows: Array<{ metric: string; dimension: string; value: number }>,
  ): void;
  shutdown(): Promise<void>;
}
const stages = new Set<Stage>([
  'http.submit',
  'http.replay',
  'http.read',
  'outbox.publish',
  'consumer.admit',
  'execution.run',
  'transaction.submit',
  'transaction.replay',
  'job.claim',
  'result.persist',
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
    // This sink performs no payload capture, network I/O or asynchronous retry.
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
  mode: 'local' | 'otlp' = 'local',
): Telemetry {
  let stdoutDrops = 0,
    metricExportFailures = 0;
  const resource = resourceFromAttributes({
    'service.name': service,
    'worker.role': role,
    'provider.mode': 'simulated',
    'service.version': /^[a-f0-9]{40}$/.test(process.env.APP_REVISION ?? '')
      ? process.env.APP_REVISION!
      : 'workspace',
  });
  const remote =
    mode === 'otlp'
      ? boundedProcessor(
          new OTLPTraceExporter({
            url: 'http://collector:4318/v1/traces',
            timeoutMillis: 750,
            concurrencyLimit: 1,
          }),
        )
      : undefined;
  const metricExporter =
    mode === 'otlp'
      ? new OTLPMetricExporter({
          url: 'http://collector:4318/v1/metrics',
          timeoutMillis: 750,
          concurrencyLimit: 1,
        })
      : undefined;
  const measuredExporter: PushMetricExporter | undefined = metricExporter
    ? {
        export: (data, callback) => {
          try {
            metricExporter.export(data, (result) => {
              if (result.code !== 0) metricExportFailures++;
              callback(result);
            });
          } catch {
            metricExportFailures++;
            callback({ code: 1 });
          }
        },
        forceFlush: () => metricExporter.forceFlush(),
        shutdown: () => metricExporter.shutdown(),
        selectAggregationTemporality: (type) =>
          metricExporter.selectAggregationTemporality(type),
      }
    : undefined;
  const meterProvider =
    mode === 'otlp'
      ? new MeterProvider({
          resource,
          readers: [
            new PeriodicExportingMetricReader({
              exporter: measuredExporter!,
              exportIntervalMillis: 2000,
              exportTimeoutMillis: 1000,
            }),
          ],
          views: [{ instrumentName: '*', aggregationCardinalityLimit: 256 }],
        })
      : undefined;
  const meter = meterProvider?.getMeter('@lab/telemetry', '1');
  const signals = meter?.createCounter('lab.operational.failures');
  const completions = meter?.createCounter('lab.stage.completions', {
    description: 'Ended stages by bounded stage and outcome',
  });
  const duration = meter?.createHistogram('lab.stage.duration', {
    unit: 's',
    advice: {
      explicitBucketBoundaries: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
    },
  });
  meter
    ?.createObservableCounter('lab.telemetry.dropped')
    .addCallback((result) => {
      result.observe(stdoutDrops, { destination: 'stdout' });
      result.observe(remote?.statistics().dropped ?? 0, {
        destination: 'otlp',
      });
    });
  meter
    ?.createObservableCounter('lab.telemetry.export.failures')
    .addCallback((result) =>
      result.observe(
        (remote?.statistics().failures ?? 0) + metricExportFailures,
      ),
    );
  meter
    ?.createObservableGauge('lab.telemetry.queue')
    .addCallback((result) => result.observe(remote?.statistics().queued ?? 0));
  const dimensions: Record<string, readonly string[]> = {
    outbox_pending: ['ticket.execution.requested', 'ticket.execution.failed'],
    outbox_oldest_seconds: [
      'ticket.execution.requested',
      'ticket.execution.failed',
    ],
    jobs: ['queued', 'running', 'failed', 'completed'],
    queue_oldest_seconds: ['queued'],
    expired_leases: ['running'],
    attempts: ['running', 'expired', 'retryable', 'failed', 'succeeded'],
    quarantine: [
      'INVALID_ENVELOPE',
      'UNSUPPORTED_EVENT',
      'EVENT_TOO_LARGE',
      'KEY_MISMATCH',
      'UNKNOWN_TICKET',
      'TENANT_MISMATCH',
      'FUTURE_GENERATION',
      'UNKNOWN_EXECUTION',
      'REASON_MISMATCH',
      'EVENT_ID_COLLISION',
      'EXECUTION_NOT_QUEUED',
    ],
  };
  let snapshot = new Map<string, number>();
  let snapshotTime = 0;
  for (const [name, values] of Object.entries(dimensions)) {
    meter?.createObservableGauge('lab.' + name).addCallback((result) => {
      for (const dimension of values)
        result.observe(snapshot.get(name + ':' + dimension) ?? 0, {
          dimension,
        });
    });
  }
  meter
    ?.createObservableGauge('lab.snapshot.age', { unit: 's' })
    .addCallback((result) => {
      result.observe(
        snapshotTime ? Math.max(0, (Date.now() - snapshotTime) / 1000) : -1,
      );
    });
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
        completions?.add(1, { stage, outcome });
        duration?.record(record.durationMs / 1000, { stage, outcome });
        if (!sink(record)) stdoutDrops++;
      } catch {
        /* Observability never determines a business outcome. */
      }
    },
  };
  const provider = new TracerProvider({
    resource,
    spanProcessors: remote ? [processor, remote] : [processor],
    spanLimits: {
      attributeCountLimit: 6,
      attributeValueLengthLimit: 64,
      eventCountLimit: 0,
      linkCountLimit: 0,
    },
  });
  const tracer = provider.getTracer('@lab/telemetry', '1');
  return {
    ...(meter
      ? {
          snapshot: (
            rows: Array<{ metric: string; dimension: string; value: number }>,
          ) => {
            if (rows.length > 64) return;
            const next = new Map<string, number>();
            for (const row of rows) {
              if (
                !dimensions[row.metric]?.includes(row.dimension) ||
                !Number.isFinite(row.value) ||
                row.value < 0
              )
                continue;
              next.set(row.metric + ':' + row.dimension, row.value);
            }
            snapshot = next;
            snapshotTime = Date.now();
          },
        }
      : {}),
    increment: (operation) => {
      if (
        [
          'dependency.postgres',
          'dependency.redis',
          'dependency.kafka',
          'lease.renew',
          'lease.complete',
          'lease.retry',
          'lease.fail',
        ].includes(operation)
      )
        signals?.add(1, { operation });
    },
    start: (stage, parent, startedAt) => {
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
              ...(startedAt instanceof Date &&
              Number.isFinite(startedAt.getTime())
                ? { startTime: startedAt }
                : {}),
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
        await Promise.allSettled([
          provider.shutdown(),
          meterProvider?.shutdown(),
        ]);
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
    const mode = process.env.LAB_TELEMETRY_MODE ?? 'local';
    if (mode !== 'local' && mode !== 'otlp')
      throw new Error('Invalid telemetry mode');
    return createTelemetry(service, role, stdoutSink, mode);
  } catch {
    return noTelemetry;
  }
}
