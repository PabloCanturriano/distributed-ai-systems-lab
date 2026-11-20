import { createHash, timingSafeEqual } from 'node:crypto';
import type { OutboxClaim, OutboxPublications } from './outbox-publications';

export interface OutboxPublisher {
  // Resolve only after broker acknowledgement. SDK-specific types stay in the adapter.
  publish(
    message: { topic: string; key: string; value: string; eventId: string },
    signal: AbortSignal,
  ): Promise<void>;
}
export class OutboxRelay {
  constructor(
    private readonly store: Pick<
      OutboxPublications,
      'claim' | 'isCurrent' | 'acknowledge' | 'retry'
    >,
    private readonly publisher: OutboxPublisher,
  ) {}
  private async publish(
    claim: OutboxClaim,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new Error('Publication interrupted');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      abort = () => {
        controller.abort();
        reject(new Error('Publication interrupted'));
      };
      timer = setTimeout(abort, 10000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      const topic =
        claim.type === 'ticket.execution.requested'
          ? 'tickets.execution-requested.v1'
          : 'tickets.execution-failed.v1';
      await Promise.race([
        this.publisher.publish(
          {
            topic,
            key: claim.ticketId,
            value: claim.payload,
            eventId: claim.eventId,
          },
          controller.signal,
        ),
        deadline,
      ]);
    } finally {
      clearTimeout(timer!);
      signal?.removeEventListener('abort', abort);
    }
  }
  async publishBatch(limit = 20, signal?: AbortSignal) {
    const result = {
      claimed: 0,
      published: 0,
      retryable: 0,
      stale: 0,
      deferred: 0,
    };
    if (signal?.aborted) return result;
    const claims = await this.store.claim(limit);
    result.claimed = claims.length;
    for (const claim of claims) {
      if (signal?.aborted) break; // Unstarted claims remain recoverable by lease expiry.
      if (!(await this.store.isCurrent(claim.eventId, claim.token))) {
        result.stale++;
        continue;
      }
      const digest = createHash('sha256').update(claim.payload).digest();
      const valid =
        claim.version === 1 &&
        ['ticket.execution.requested', 'ticket.execution.failed'].includes(
          claim.type,
        ) &&
        claim.payloadDigest.length === 32 &&
        timingSafeEqual(digest, claim.payloadDigest);
      if (!valid) {
        if (await this.store.retry(claim.eventId, claim.token, 'INVALID_EVENT'))
          result.retryable++;
        else result.stale++;
        continue;
      }
      try {
        await this.publish(claim, signal);
      } catch {
        if (
          await this.store.retry(claim.eventId, claim.token, 'PUBLISH_FAILED')
        )
          result.retryable++;
        else result.stale++;
        continue;
      }
      // Keep acknowledgement failures outside the publish-error handler: a lost
      // commit reply must not turn a possibly published row back into retry state.
      if (await this.store.acknowledge(claim.eventId, claim.token))
        result.published++;
      else result.stale++;
    }
    result.deferred =
      result.claimed - result.published - result.retryable - result.stale;
    return result;
  }
}
