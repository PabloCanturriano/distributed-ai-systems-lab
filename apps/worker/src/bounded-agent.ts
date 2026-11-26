import { z } from 'zod';
import {
  citationSchema,
  evidenceResultSchema,
  validateEvidenceResult,
  type Evidence,
  type EvidenceResult,
} from '@lab/knowledge';

export const agentPolicy = 'bounded-agent-v1';
export type AgentErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'INVALID_MODEL_OUTPUT'
  | 'INVALID_TOOL_RESULT'
  | 'INVALID_EVIDENCE'
  | 'TOOL_FORBIDDEN'
  | 'TOOL_TIMEOUT'
  | 'MODEL_TIMEOUT'
  | 'ATTEMPT_TIMEOUT'
  | 'BUDGET_EXHAUSTED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'ABORTED';
export class AgentError extends Error {
  readonly classification: 'permanent' | 'retryable';
  constructor(readonly code: AgentErrorCode) {
    super(code);
    this.classification = [
      'TOOL_TIMEOUT',
      'MODEL_TIMEOUT',
      'ATTEMPT_TIMEOUT',
      'DEPENDENCY_UNAVAILABLE',
    ].includes(code)
      ? 'retryable'
      : 'permanent';
  }
}
const text = (max: number) =>
  z
    .string()
    .refine(
      (value) =>
        value.trim().length > 0 &&
        Array.from(value).length <= max &&
        !value.includes('\0') &&
        !/[\uD800-\uDFFF]/u.test(value),
    );
const scopeSchema = z.strictObject({
  tenantId: z.uuid(),
  snapshotId: z.uuid(),
});
export type AgentScope = z.infer<typeof scopeSchema>;
const searchSchema = z.strictObject({
  query: z.string().trim().pipe(text(500)),
});
const serviceSchema = z.strictObject({
  serviceId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
});
const ticketSchema = z.strictObject({
  ticketId: z.uuid().transform((v) => v.toLowerCase()),
});
const toolDecision = z.discriminatedUnion('name', [
  z.strictObject({
    kind: z.literal('tool'),
    name: z.literal('search_documentation'),
    arguments: searchSchema,
  }),
  z.strictObject({
    kind: z.literal('tool'),
    name: z.literal('get_service_status'),
    arguments: serviceSchema,
  }),
  z.strictObject({
    kind: z.literal('tool'),
    name: z.literal('get_ticket'),
    arguments: ticketSchema,
  }),
]);
const decisionSchema = z.union([
  toolDecision,
  z.strictObject({ kind: z.literal('final'), result: evidenceResultSchema }),
]);
export type ToolDecision = z.infer<typeof toolDecision>;
export type ToolName = ToolDecision['name'];
export const evidenceSchema = citationSchema.extend({
  tenantId: z.uuid(),
  snapshotId: z.uuid(),
  content: text(2048).refine((v) => Buffer.byteLength(v) <= 2048),
  score: z.number().finite().min(0).max(1),
});
const notFound = z.strictObject({ code: z.literal('NOT_FOUND') });
const serviceResult = z.union([
  notFound,
  z.strictObject({
    serviceId: serviceSchema.shape.serviceId,
    status: z.enum(['operational', 'degraded', 'unavailable']),
    observedAt: z.iso.datetime(),
  }),
]);
const ticketResult = z.union([
  notFound,
  z.strictObject({
    ticketId: z.uuid(),
    generation: z.number().int().positive(),
    status: z.enum(['queued', 'processing', 'completed', 'failed']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
]);
export type ServiceToolResult = z.infer<typeof serviceResult>;
export type TicketToolResult = z.infer<typeof ticketResult>;
// These ports receive executor-owned scope, never a tenant supplied by the model.
export interface AgentTools {
  search(
    scope: AgentScope,
    query: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  serviceStatus(
    scope: AgentScope,
    serviceId: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  ticket(
    scope: AgentScope,
    ticketId: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface AgentModelInput {
  question: string;
  evidence: Evidence[];
  history: Array<{ name: ToolName; result: unknown }>;
}
export interface AgentModel {
  readonly mode: 'simulated';
  decide(input: AgentModelInput, signal: AbortSignal): Promise<unknown>;
}
export interface AgentOutput {
  result: EvidenceResult;
  deliveredEvidence: Evidence[];
  summary: {
    policy: typeof agentPolicy;
    providerMode: 'simulated';
    modelTurns: number;
    toolCalls: Array<{ name: ToolName; outcome: 'observed' | 'not_found' }>;
  };
}
function bytes(input: unknown, max: number, code: AgentErrorCode): void {
  try {
    const json = JSON.stringify(input);
    if (!json || Buffer.byteLength(json) > max) throw Error();
  } catch {
    throw new AgentError(code);
  }
}
function checkedEvidence(input: unknown, scope: AgentScope): Evidence[] {
  const parsed = z.array(evidenceSchema).max(5).safeParse(input);
  if (
    !parsed.success ||
    parsed.data.some(
      (row) =>
        row.tenantId !== scope.tenantId || row.snapshotId !== scope.snapshotId,
    ) ||
    new Set(parsed.data.map((row) => row.chunkId)).size !== parsed.data.length
  )
    throw new AgentError('INVALID_EVIDENCE');
  return parsed.data;
}

// A timed-out call is never followed by another call in this run. A dependency
// may ignore cancellation; database fencing is still required by the caller.
async function bounded<T>(
  parent: AbortSignal,
  expires: number,
  cap: number,
  code: 'MODEL_TIMEOUT' | 'TOOL_TIMEOUT',
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw new AgentError('ABORTED');
  const remaining = expires - performance.now();
  if (remaining <= 0) throw new AgentError('ATTEMPT_TIMEOUT');
  const deadline = performance.now() + Math.min(cap, remaining);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new AgentError('ABORTED'));
      };
      parent.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new AgentError(remaining <= cap ? 'ATTEMPT_TIMEOUT' : code));
        },
        Math.min(cap, remaining),
      );
    });
    const value = await Promise.race([
      Promise.resolve().then(() => {
        if (parent.aborted) throw new AgentError('ABORTED');
        return call(controller.signal);
      }),
      cancelled,
    ]);
    if (parent.aborted) throw new AgentError('ABORTED');
    if (performance.now() >= deadline)
      throw new AgentError(
        performance.now() >= expires ? 'ATTEMPT_TIMEOUT' : code,
      );
    return value;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('DEPENDENCY_UNAVAILABLE');
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener('abort', onAbort);
  }
}
export async function runBoundedAgent(input: {
  context: AgentScope;
  question: string;
  signal: AbortSignal;
  model: AgentModel;
  tools: AgentTools;
}): Promise<AgentOutput> {
  const scope = scopeSchema.safeParse(input.context),
    question = text(4000).safeParse(input.question);
  if (!scope.success || !question.success || input.model.mode !== 'simulated')
    throw new AgentError('INVALID_ARGUMENTS');
  const expires = performance.now() + 60_000;
  const search = (query: string) =>
    bounded(input.signal, expires, 3_000, 'TOOL_TIMEOUT', (signal) =>
      input.tools.search({ ...scope.data }, query, signal),
    );
  let evidence = checkedEvidence(await search(question.data), scope.data);
  const history: AgentModelInput['history'] = [];
  const toolCalls: AgentOutput['summary']['toolCalls'] = [];
  for (let turn = 1; turn <= 4; turn++) {
    const raw = await bounded(
      input.signal,
      expires,
      15_000,
      'MODEL_TIMEOUT',
      (signal) =>
        input.model.decide(
          structuredClone({ question: question.data, evidence, history }),
          signal,
        ),
    );
    bytes(raw, 12_288, 'INVALID_MODEL_OUTPUT');
    const parsed = decisionSchema.safeParse(raw);
    if (!parsed.success) {
      if (
        raw &&
        typeof raw === 'object' &&
        'kind' in raw &&
        raw.kind === 'tool'
      ) {
        if (
          !('name' in raw) ||
          ![
            'search_documentation',
            'get_service_status',
            'get_ticket',
          ].includes(String(raw.name))
        )
          throw new AgentError('TOOL_FORBIDDEN');
        throw new AgentError('INVALID_ARGUMENTS');
      }
      throw new AgentError('INVALID_MODEL_OUTPUT');
    }
    const decision = parsed.data;
    if (decision.kind === 'final') {
      let result: EvidenceResult;
      try {
        result = validateEvidenceResult(decision.result, {
          ...scope.data,
          evidence,
        });
      } catch {
        throw new AgentError('INVALID_MODEL_OUTPUT');
      }
      const summary: AgentOutput['summary'] = {
        policy: agentPolicy,
        providerMode: 'simulated',
        modelTurns: turn,
        toolCalls,
      };
      bytes(summary, 4096, 'INVALID_TOOL_RESULT');
      return structuredClone({ result, deliveredEvidence: evidence, summary });
    }
    // Turn four must produce a final answer; no tool can consume an unusable
    // last turn. Counters are checked before invoking any dependency.
    if (toolCalls.length >= 3 || turn === 4)
      throw new AgentError('BUDGET_EXHAUSTED');
    let result: unknown;
    if (decision.name === 'search_documentation') {
      const retrieved = checkedEvidence(
        await search(decision.arguments.query),
        scope.data,
      );
      bytes(retrieved, 8192, 'INVALID_TOOL_RESULT');
      const combined = new Map(evidence.map((row) => [row.chunkId, row]));
      for (const row of retrieved) {
        const prior = combined.get(row.chunkId);
        if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
          // Scores can vary with the query; immutable source identity cannot.
          if (
            prior.content !== row.content ||
            prior.documentId !== row.documentId ||
            prior.documentVersion !== row.documentVersion
          )
            throw new AgentError('INVALID_EVIDENCE');
        }
        if (!prior) combined.set(row.chunkId, row);
      }
      evidence = checkedEvidence([...combined.values()], scope.data);
      result = retrieved;
    } else {
      const rawResult = await bounded(
        input.signal,
        expires,
        3_000,
        'TOOL_TIMEOUT',
        (signal) =>
          decision.name === 'get_service_status'
            ? input.tools.serviceStatus(
                { ...scope.data },
                decision.arguments.serviceId,
                signal,
              )
            : input.tools.ticket(
                { ...scope.data },
                decision.arguments.ticketId,
                signal,
              ),
      );
      bytes(rawResult, 8192, 'INVALID_TOOL_RESULT');
      const validated =
        decision.name === 'get_service_status'
          ? serviceResult.safeParse(rawResult)
          : ticketResult.safeParse(rawResult);
      if (!validated.success) throw new AgentError('INVALID_TOOL_RESULT');
      result = validated.data;
      if (
        !('code' in validated.data) &&
        (decision.name === 'get_service_status'
          ? !('serviceId' in validated.data) ||
            validated.data.serviceId !== decision.arguments.serviceId
          : !('ticketId' in validated.data) ||
            validated.data.ticketId !== decision.arguments.ticketId)
      )
        throw new AgentError('INVALID_TOOL_RESULT');
    }
    toolCalls.push({
      name: decision.name,
      outcome:
        result && typeof result === 'object' && 'code' in result
          ? 'not_found'
          : 'observed',
    });
    history.push({ name: decision.name, result: structuredClone(result) });
  }
  throw new AgentError('BUDGET_EXHAUSTED');
}

// Fixture decisions are data, independent of question or retrieved content.
// This adapter is a workflow test aid, never a real-model quality claim.
export class ScriptedAgentModel implements AgentModel {
  readonly mode = 'simulated';
  private cursor = 0;
  private readonly decisions: unknown[];
  constructor(decisions: unknown[]) {
    if (decisions.length > 4) throw new AgentError('INVALID_ARGUMENTS');
    this.decisions = structuredClone(decisions);
  }
  async decide(_input: AgentModelInput, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new AgentError('ABORTED');
    if (this.cursor >= this.decisions.length)
      throw new AgentError('INVALID_MODEL_OUTPUT');
    return structuredClone(this.decisions[this.cursor++]);
  }
}
