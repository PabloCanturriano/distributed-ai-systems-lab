import type { Pool } from 'pg';
import { noTelemetry, type Telemetry, type Stage } from '@lab/telemetry';
import {
  runBoundedAgent,
  AgentError,
  type AgentModel,
  type AgentModelInput,
  type AgentTools,
} from './bounded-agent';
import { EvidenceProvider, scriptedAnswer } from './evidence-provider';
import { ExecutionEvidence } from './execution-evidence';
import { KnowledgeRetrieval } from './knowledge-retrieval';
import { ReadOnlyAgentTools } from './agent-tools';
import { ExecutionProviderError, type ExecutionProvider } from './job-executor';
// Fixed offline workflow, not a planner. Source text is never interpreted as
// commands. Read-only tool results exercise the same contracts as model output.
export class OfflineTicketModel implements AgentModel {
  readonly mode = 'simulated';
  constructor(private readonly ticketId: string) {}
  async decide(input: AgentModelInput, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new AgentError('ABORTED');
    const called = new Set(input.history.map((row) => row.name));
    if (
      !called.has('search_documentation') &&
      Array.from(input.question.trim()).length <= 500
    )
      return {
        kind: 'tool',
        name: 'search_documentation',
        arguments: { query: input.question.trim() },
      };
    if (!called.has('get_ticket'))
      return {
        kind: 'tool',
        name: 'get_ticket',
        arguments: { ticketId: this.ticketId },
      };
    if (!called.has('get_service_status'))
      return {
        kind: 'tool',
        name: 'get_service_status',
        arguments: { serviceId: 'support-api' },
      };
    return {
      kind: 'final',
      result: scriptedAnswer(input.question, input.evidence),
    };
  }
}
export class AgentProvider implements ExecutionProvider {
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly catalogue: unknown,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}
  async execute(
    claim: Parameters<ExecutionProvider['execute']>[0],
    signal: AbortSignal,
  ): Promise<unknown> {
    const evidence = new ExecutionEvidence(this.pool),
      retrieval = new KnowledgeRetrieval(this.pool);
    try {
      const context = await evidence.load(claim);
      if (context?.policy !== 'bounded-agent-v1')
        return new EvidenceProvider(
          evidence,
          retrieval,
          this.telemetry,
        ).execute(claim, signal);
      const rawTools = new ReadOnlyAgentTools(
        { tenantId: context.tenantId, snapshotId: context.snapshotId },
        this.pool,
        retrieval,
        this.catalogue,
        context.policy,
      );
      const observe = async <T>(
        stage: Stage,
        action: (parent?: string) => Promise<T>,
        parent = claim.traceParent,
      ) => {
        const span = this.telemetry.start(stage, parent);
        try {
          const result = await action(span.traceParent);
          span.end('observed', {
            ticketId: claim.ticketId,
            attemptId: claim.attemptId,
            generation: claim.generation,
          });
          return result;
        } catch (error) {
          span.end('failed', {
            ticketId: claim.ticketId,
            attemptId: claim.attemptId,
            generation: claim.generation,
          });
          throw error;
        }
      };
      let searches = 0;
      const tools: AgentTools = {
        search: (...args) =>
          ++searches === 1
            ? observe('retrieval.search', () => rawTools.search(...args))
            : observe('tool.run', (parent) =>
                observe(
                  'retrieval.search',
                  () => rawTools.search(...args),
                  parent,
                ),
              ),
        serviceStatus: (...args) =>
          observe('tool.run', () => rawTools.serviceStatus(...args)),
        ticket: (...args) =>
          observe('tool.run', () => rawTools.ticket(...args)),
      };
      const model = new OfflineTicketModel(claim.ticketId);
      const output = await runBoundedAgent({
        context: { tenantId: context.tenantId, snapshotId: context.snapshotId },
        question: context.message,
        signal,
        tools,
        model: {
          mode: 'simulated',
          decide: (...args) =>
            observe('model.decide', () => model.decide(...args)),
        },
      });
      if (signal.aborted) throw new AgentError('ABORTED');
      // No writes here: completion persists evidence, citations, summary and
      // lifecycle in one transaction after checking the current database lease.
      return {
        ...output.result,
        agent: { summary: output.summary, evidence: output.deliveredEvidence },
      };
    } catch (error) {
      throw new ExecutionProviderError(
        error instanceof AgentError ? error.classification : 'retryable',
      );
    }
  }
}
