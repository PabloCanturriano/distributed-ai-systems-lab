import type { ExecutionProvider } from './job-executor';

// This version has no corpus or tools. It must abstain, not manufacture evidence
// or present a scripted response as model reasoning.
export class SimulatedAbstentionProvider implements ExecutionProvider {
  async execute(
    _claim: Parameters<ExecutionProvider['execute']>[0],
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw new Error('Execution interrupted');
    return {
      outcome: 'insufficient_evidence' as const,
      answer:
        'The simulated local provider has no indexed documentation available for this ticket.',
    };
  }
}
