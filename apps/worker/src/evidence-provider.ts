import { noTelemetry, type Telemetry } from '@lab/telemetry';
import {
  tokens,
  validateEvidenceResult,
  type Evidence,
  type EvidenceResult,
} from '@lab/knowledge';
import type { ExecutionProvider } from './job-executor';
import { ExecutionProviderError } from './job-executor';
import { SimulatedAbstentionProvider } from './simulated-provider';
import type { ExecutionEvidence } from './execution-evidence';
import type { KnowledgeRetrieval } from './knowledge-retrieval';
export const evidenceAbstention =
  'The indexed evidence is insufficient to support this fictional question.';
export function scriptedAnswer(
  query: string,
  evidence: Evidence[],
): EvidenceResult {
  const stop = new Set([
    'a',
    'an',
    'the',
    'is',
    'to',
    'and',
    'or',
    'of',
    'for',
    'this',
    'that',
    'what',
    'how',
    'in',
    'with',
    'can',
  ]);
  const queryTokens = new Set(tokens(query).filter((t) => !stop.has(t)));
  const selected = evidence.find(
    (row) =>
      new Set(tokens(row.content).filter((t) => queryTokens.has(t))).size >= 2,
  );
  if (!selected)
    return {
      outcome: 'insufficient_evidence',
      answer: evidenceAbstention,
      citations: [],
    };
  return {
    outcome: 'answered',
    answer:
      'Simulated excerpt from indexed documentation:\n' + selected.content,
    citations: [
      {
        documentId: selected.documentId,
        documentVersion: selected.documentVersion,
        chunkId: selected.chunkId,
      },
    ],
  };
}
export class EvidenceProvider implements ExecutionProvider {
  constructor(
    private readonly store: ExecutionEvidence,
    private readonly retrieval: KnowledgeRetrieval,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}
  async execute(
    claim: Parameters<ExecutionProvider['execute']>[0],
    signal: AbortSignal,
  ): Promise<EvidenceResult | unknown> {
    if (signal.aborted) throw Error('Execution interrupted');
    try {
      const context = await this.store.load(claim);
      if (!context)
        return new SimulatedAbstentionProvider().execute(claim, signal);
      const span = this.telemetry.start('retrieval.search', claim.traceParent);
      let evidence: Evidence[];
      try {
        evidence = await this.retrieval.search({
          tenantId: context.tenantId,
          snapshotId: context.snapshotId,
          profile: context.profile,
          policy: context.policy,
          query: context.message,
        });
        span.end('observed', {
          ticketId: claim.ticketId,
          attemptId: claim.attemptId,
          generation: claim.generation,
        });
      } catch (error) {
        span.end('failed');
        throw error;
      }
      if (signal.aborted) throw Error();
      await this.store.record(claim, context, evidence);
      const result = scriptedAnswer(context.message, evidence);
      return validateEvidenceResult(result, {
        tenantId: context.tenantId,
        snapshotId: context.snapshotId,
        evidence,
      });
    } catch {
      throw new ExecutionProviderError('retryable');
    }
  }
}
