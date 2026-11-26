import type { Pool } from 'pg';
import { z } from 'zod';
import type { KnowledgeRetrieval } from './knowledge-retrieval';
import {
  AgentError,
  type AgentScope,
  type AgentTools,
  type ServiceToolResult,
  type TicketToolResult,
} from './bounded-agent';
const scopeSchema = z.strictObject({
  tenantId: z.uuid(),
  snapshotId: z.uuid(),
});
const serviceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const catalogueSchema = z.strictObject({
  version: z.literal('services-v1'),
  services: z
    .array(
      z.strictObject({
        tenantId: z.uuid(),
        serviceId: serviceIdSchema,
        status: z.enum(['operational', 'degraded', 'unavailable']),
        observedAt: z.iso.datetime(),
      }),
    )
    .max(100),
});
// The host supplies the owned fictional catalogue, not a model-selected path.
// No public endpoint, remote probe, or tenant-selected URL is exposed.
export class ReadOnlyAgentTools implements AgentTools {
  private readonly scope: AgentScope;
  private readonly services: z.infer<typeof catalogueSchema>['services'];
  constructor(
    context: AgentScope,
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly retrieval: Pick<KnowledgeRetrieval, 'search'>,
    catalogue: unknown,
    private readonly policy:
      | 'extractive-simulated-v1'
      | 'bounded-agent-v1' = 'extractive-simulated-v1',
  ) {
    const scope = scopeSchema.safeParse(context),
      parsed = catalogueSchema.safeParse(catalogue);
    if (!scope.success || !parsed.success)
      throw new AgentError('INVALID_ARGUMENTS');
    const keys = parsed.data.services.map(
      (row) => `${row.tenantId}:${row.serviceId}`,
    );
    if (new Set(keys).size !== keys.length)
      throw new AgentError('INVALID_ARGUMENTS');
    this.scope = scope.data;
    this.services = parsed.data.services;
  }
  private authorize(scope: AgentScope, signal: AbortSignal): void {
    if (signal.aborted) throw new AgentError('ABORTED');
    const parsed = scopeSchema.safeParse(scope);
    if (
      !parsed.success ||
      parsed.data.tenantId !== this.scope.tenantId ||
      parsed.data.snapshotId !== this.scope.snapshotId
    )
      throw new AgentError('TOOL_FORBIDDEN');
  }
  async search(
    scope: AgentScope,
    query: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.authorize(scope, signal);
    // Reuses the approved phase-four retrieval profile; this adapter does not
    // change durable execution configurations or activate a new agent policy.
    try {
      const result = await this.retrieval.search({
        ...this.scope,
        profile: 'lexical-hash-v1',
        policy: this.policy,
        query,
      });
      this.authorize(scope, signal);
      return result;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('DEPENDENCY_UNAVAILABLE');
    }
  }
  async serviceStatus(
    scope: AgentScope,
    serviceId: string,
    signal: AbortSignal,
  ): Promise<ServiceToolResult> {
    this.authorize(scope, signal);
    if (!serviceIdSchema.safeParse(serviceId).success)
      throw new AgentError('INVALID_ARGUMENTS');
    const row = this.services.find(
      (value) =>
        value.tenantId === this.scope.tenantId && value.serviceId === serviceId,
    );
    if (!row) return { code: 'NOT_FOUND' };
    return {
      serviceId: row.serviceId,
      status: row.status,
      observedAt: row.observedAt,
    };
  }
  async ticket(
    scope: AgentScope,
    ticketId: string,
    signal: AbortSignal,
  ): Promise<TicketToolResult> {
    this.authorize(scope, signal);
    if (!z.uuid().safeParse(ticketId).success)
      throw new AgentError('INVALID_ARGUMENTS');
    const client = await this.pool.connect().catch(() => {
      throw new AgentError('DEPENDENCY_UNAVAILABLE');
    });
    let discard = false;
    try {
      this.authorize(scope, signal);
      await client.query('BEGIN READ ONLY');
      await client.query(
        "SET LOCAL ROLE lab_worker; SET LOCAL statement_timeout='1s'; SET LOCAL lock_timeout='1s'",
      );
      const result = await client.query<{
        id: string;
        current_generation: number;
        status: 'queued' | 'processing' | 'completed' | 'failed';
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT t.id,t.current_generation,e.status,e.created_at,e.updated_at
        FROM lab.tickets t JOIN lab.ticket_executions e ON e.tenant_id=t.tenant_id AND e.ticket_id=t.id AND e.generation=t.current_generation
        WHERE t.tenant_id=$1 AND t.id=$2`,
        [this.scope.tenantId, ticketId],
      );
      this.authorize(scope, signal);
      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) return { code: 'NOT_FOUND' };
      return {
        ticketId: row.id,
        generation: row.current_generation,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    } catch (error) {
      discard = true;
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof AgentError) throw error;
      throw new AgentError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
}
