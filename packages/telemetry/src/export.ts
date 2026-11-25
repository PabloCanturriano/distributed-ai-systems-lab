import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace';

export interface ExportStatistics {
  queued: number;
  inFlight: number;
  dropped: number;
  failures: number;
}
// One request at a time, fixed storage, no retries that amplify an outage.
// A timed-out exporter must finish before another request may begin.
export function boundedProcessor(
  exporter: SpanExporter,
  timeoutMs = 1000,
): SpanProcessor & { statistics(): ExportStatistics } {
  const queue: ReadableSpan[] = [];
  let inFlight = false,
    dropped = 0,
    failures = 0,
    closed = false;
  const drain = (): void => {
    if (inFlight || closed || !queue.length) return;
    const batch = queue.splice(0, 32);
    inFlight = true;
    let settled = false;
    const deadline = setTimeout(() => {
      if (!settled) {
        failures++;
        settled = true;
      }
    }, timeoutMs);
    deadline.unref();
    const done = (success: boolean): void => {
      clearTimeout(deadline);
      if (!settled && !success) failures++;
      settled = true;
      inFlight = false;
    };
    try {
      exporter.export(batch, (result) => done(result.code === 0));
    } catch {
      done(false);
    }
  };
  const timer = setInterval(drain, 200);
  timer.unref();
  return {
    onStart: () => {},
    onEnd: (span) => {
      if (closed || queue.length >= 128) {
        dropped++;
        return;
      }
      queue.push(span);
    },
    statistics: () => ({
      queued: queue.length,
      inFlight: Number(inFlight),
      dropped,
      failures,
    }),
    forceFlush: async () => {
      drain();
    },
    shutdown: async () => {
      closed = true;
      clearInterval(timer);
      dropped += queue.length;
      queue.length = 0;
      // Never await a broken exporter without a deadline.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs);
        try {
          void exporter.shutdown().then(
            () => {
              clearTimeout(timeout);
              resolve();
            },
            () => {
              clearTimeout(timeout);
              failures++;
              resolve();
            },
          );
        } catch {
          clearTimeout(timeout);
          failures++;
          resolve();
        }
      });
    },
  };
}
