import {
  noTelemetry,
  type Telemetry,
  type Outcome as TraceOutcome,
} from '@lab/telemetry';
import { randomInt } from 'node:crypto';
import {
  ExecutionOwnershipError,
  type ExecutionClaim,
  type ExecutionOwnership,
} from './execution-ownership';

export interface ExecutionProvider {
  execute(claim: ExecutionClaim, signal: AbortSignal): Promise<unknown>;
}
export class ExecutionProviderError extends Error {
  constructor(readonly classification: 'retryable' | 'permanent') {
    super('Execution provider failed');
  }
}
type Store = Pick<
  ExecutionOwnership,
  'claim' | 'renew' | 'complete' | 'retry' | 'fail'
>;
type ExecutorEvent =
  | 'executor_completed'
  | 'executor_stale'
  | 'executor_retry_recorded'
  | 'executor_failure_recorded'
  | 'executor_dependency_unavailable'
  | 'executor_attempt_interrupted';
type Outcome =
  | { kind: 'result'; value: unknown }
  | { kind: 'error'; error: unknown }
  | { kind: 'interrupted' };

// Resolve on timeout or cancellation, releasing both the timer and listener.
// Global timers keep the same policy controllable with Jest's fake clock.
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

export class JobExecutor {
  constructor(
    private readonly store: Store,
    private readonly provider: ExecutionProvider,
    private readonly report: (event: ExecutorEvent) => void = () => {},
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const worker = async () => {
      while (!signal.aborted) {
        try {
          await this.runOnce(signal);
        } catch {
          this.report('executor_dependency_unavailable');
        }
        if (!signal.aborted) await wait(500 + randomInt(101), signal);
      }
    };
    // At most two claimed attempts per process; each loop waits for finalization.
    await Promise.all([worker(), worker()]);
  }

  async runOnce(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const claim = await this.store.claim();
    if (!claim) return false;
    if (signal.aborted) return true; // A claim that raced shutdown recovers by expiry.
    const span = this.telemetry.start('execution.run', claim.traceParent);
    let traceOutcome: TraceOutcome = 'interrupted';
    try {
      const work = new AbortController(),
        heartbeat = new AbortController();
      let reason: 'shutdown' | 'ownership' | 'deadline' | undefined;
      const interrupt = (value: NonNullable<typeof reason>) => {
        if (!reason || value === 'ownership' || value === 'shutdown') {
          reason = value;
        }
        work.abort();
      };
      const shutdown = () => interrupt('shutdown');
      signal.addEventListener('abort', shutdown, { once: true });
      let interruptWait: () => void = () => {};
      const interrupted = new Promise<Outcome>((resolve) => {
        interruptWait = () => resolve({ kind: 'interrupted' });
        work.signal.addEventListener('abort', interruptWait, { once: true });
      });
      const started = performance.now();
      const deadline = setTimeout(() => interrupt('deadline'), 60000);
      if (signal.aborted) shutdown();
      const renewals = (async () => {
        while (!heartbeat.signal.aborted && !work.signal.aborted) {
          await wait(5000, heartbeat.signal);
          if (heartbeat.signal.aborted || work.signal.aborted) break;
          try {
            if (!(await this.store.renew(claim.jobId, claim.attemptId))) {
              interrupt('ownership');
              break;
            }
          } catch {
            this.report('executor_dependency_unavailable');
            interrupt('ownership');
            break;
          }
        }
      })();
      let outcome: Outcome;
      try {
        const execution = Promise.resolve()
          .then(() => {
            if (work.signal.aborted) throw new Error('Execution interrupted');
            return this.provider.execute(
              span.traceParent
                ? { ...claim, traceParent: span.traceParent }
                : claim,
              work.signal,
            );
          })
          .then<Outcome, Outcome>(
            (value) => ({ kind: 'result', value }),
            (error) => ({ kind: 'error', error }),
          );
        if (work.signal.aborted) interruptWait();
        outcome = await Promise.race([execution, interrupted]);
      } finally {
        // Drain an in-flight renewal before finalization; a failed renewal means
        // that even a ready provider result must be discarded.
        heartbeat.abort();
        await renewals;
        clearTimeout(deadline);
        signal.removeEventListener('abort', shutdown);
        work.signal.removeEventListener('abort', interruptWait);
      }
      if (signal.aborted || reason === 'shutdown' || reason === 'ownership') {
        this.report('executor_attempt_interrupted');
        return true;
      }
      if (reason === 'deadline' || performance.now() - started >= 60000) {
        work.abort();
        traceOutcome = await this.finish(claim, true);
        return true;
      }
      if (outcome.kind === 'error') {
        work.abort();
        traceOutcome = await this.finish(
          claim,
          outcome.error instanceof ExecutionProviderError &&
            outcome.error.classification === 'retryable',
        );
      } else if (outcome.kind === 'result') {
        try {
          const saved = await this.store.complete(
            claim.jobId,
            claim.attemptId,
            outcome.value,
            ...(span.traceParent ? ([span.traceParent] as [string]) : []),
          );
          this.report(saved ? 'executor_completed' : 'executor_stale');
          traceOutcome = saved ? 'completed' : 'stale';
        } catch (error) {
          // Invalid output is rejected before SQL. Other completion errors may
          // follow a committed result: never reclassify them as provider failure.
          if (
            error instanceof ExecutionOwnershipError &&
            error.code === 'INVALID_REQUEST'
          )
            traceOutcome = await this.finish(claim, false);
          else this.report('executor_dependency_unavailable');
        }
      }
      return true;
    } finally {
      span.end(traceOutcome, {
        ticketId: claim.ticketId,
        attemptId: claim.attemptId,
        generation: claim.generation,
      });
    }
  }
  private async finish(
    claim: ExecutionClaim,
    retry: boolean,
  ): Promise<TraceOutcome> {
    try {
      const saved = await this.store[retry ? 'retry' : 'fail'](
        claim.jobId,
        claim.attemptId,
      );
      this.report(
        saved
          ? retry
            ? 'executor_retry_recorded'
            : 'executor_failure_recorded'
          : 'executor_stale',
      );
      return saved ? (retry ? 'retryable' : 'failed') : 'stale';
    } catch {
      this.report('executor_dependency_unavailable');
      return 'interrupted';
    }
  }
}
