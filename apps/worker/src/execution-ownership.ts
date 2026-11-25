import { citationSchema } from '@lab/knowledge';
import { validTraceParent, noTelemetry, type Telemetry } from '@lab/telemetry';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export interface ExecutionClaim {
  traceParent?: string;
  jobId: string;
  tenantId: string;
  ticketId: string;
  generation: number;
  attemptId: string;
  attemptNumber: number;
  leaseExpiresAt: string;
}
export class ExecutionOwnershipError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'DEPENDENCY_UNAVAILABLE') {
    super(code);
    this.name = 'ExecutionOwnershipError';
  }
}
interface LockedJob {
  trace_parent: string | null;
  id: string;
  tenant_id: string;
  ticket_id: string;
  generation: number;
  status: string;
  attempt_count: number;
  max_attempts: number;
  attempt_id: string | null;
  source_event_id: string;
  current_generation: number;
  execution_status: string;
  correlation_id: string;
}
const identity = z.tuple([z.uuid(), z.uuid()]);
const resultSchema = z
  .strictObject({
    outcome: z.enum(['answered', 'insufficient_evidence']),
    citations: z.array(citationSchema).max(5).default([]),
    answer: z
      .string()
      .refine(
        (value) =>
          value.trim().length > 0 &&
          Buffer.byteLength(value, 'utf8') <= 8192 &&
          !value.includes('\0') &&
          !/[\uD800-\uDFFF]/u.test(value),
      ),
  })
  .refine(
    (value) =>
      (value.outcome === 'answered') === value.citations.length > 0 &&
      new Set(value.citations.map((c) => c.chunkId)).size ===
        value.citations.length,
  );
export class ExecutionOwnership {
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}
  private async transaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new ExecutionOwnershipError('DEPENDENCY_UNAVAILABLE');
    }
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        "SET LOCAL ROLE lab_worker; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
      );
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      discard = true;
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof ExecutionOwnershipError) throw error;
      throw new ExecutionOwnershipError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
  private async lock(
    client: PoolClient,
    id: string,
  ): Promise<LockedJob | undefined> {
    const location = (
      await client.query<{
        tenant_id: string;
        ticket_id: string;
        generation: number;
      }>(
        'SELECT tenant_id,ticket_id,generation FROM lab.execution_jobs WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!location) return undefined;
    const ticket = (
      await client.query<{ current_generation: number }>(
        'SELECT current_generation FROM lab.tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [location.tenant_id, location.ticket_id],
      )
    ).rows[0];
    if (!ticket) return undefined;
    const execution = (
      await client.query<{ status: string; correlation_id: string }>(
        'SELECT status,correlation_id FROM lab.ticket_executions WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3 FOR UPDATE',
        [location.tenant_id, location.ticket_id, location.generation],
      )
    ).rows[0];
    const job = (
      await client.query<LockedJob>(
        'SELECT * FROM lab.execution_jobs WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!job || !execution) return undefined;
    return {
      ...job,
      current_generation: ticket.current_generation,
      execution_status: execution.status,
      correlation_id: execution.correlation_id,
    };
  }
  private async owned(
    client: PoolClient,
    job: LockedJob,
    token: string,
  ): Promise<boolean> {
    if (
      job.current_generation !== job.generation ||
      job.execution_status !== 'processing'
    )
      return false;
    // The ticket, execution and job are locked before evaluating fresh DB time.
    return (
      (
        await client.query(
          "SELECT id FROM lab.execution_jobs WHERE id=$1 AND status='running' AND attempt_id=$2 AND lease_expires_at>clock_timestamp()",
          [job.id, token],
        )
      ).rowCount === 1
    );
  }
  private async endAttempt(
    client: PoolClient,
    job: LockedJob,
    status: 'expired' | 'retryable' | 'failed' | 'succeeded',
    code: string | null,
  ): Promise<void> {
    const result = await client.query(
      "UPDATE lab.execution_attempts SET status=$3,finished_at=clock_timestamp(),failure_code=$4 WHERE id=$1 AND job_id=$2 AND status='running'",
      [job.attempt_id, job.id, status, code],
    );
    if (result.rowCount !== 1)
      throw new ExecutionOwnershipError('DEPENDENCY_UNAVAILABLE');
  }
  private async terminal(
    client: PoolClient,
    job: LockedJob,
    code: 'EXECUTION_FAILED' | 'ATTEMPTS_EXHAUSTED',
  ): Promise<void> {
    await client.query(
      "UPDATE lab.execution_jobs SET status='failed',attempt_id=NULL,lease_expires_at=NULL,failure_code=$2,failed_at=clock_timestamp() WHERE id=$1",
      [job.id, code],
    );
    await client.query(
      "UPDATE lab.ticket_executions SET status='failed',updated_at=clock_timestamp() WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3",
      [job.tenant_id, job.ticket_id, job.generation],
    );
    const now = (
      await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now;
    const eventId = randomUUID();
    const payload = JSON.stringify({
      eventId,
      type: 'ticket.execution.failed',
      version: 1,
      occurredAt: now.toISOString(),
      tenantId: job.tenant_id,
      ticketId: job.ticket_id,
      generation: job.generation,
      correlationId: job.correlation_id,
      causationId: job.source_event_id,
      data: { failureCode: code, attemptCount: job.attempt_count },
    });
    await client.query(
      `INSERT INTO lab.outbox_events(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest${validTraceParent(job.trace_parent) ? ',trace_parent' : ''}) VALUES($1,$2,$3,$4,'ticket.execution.failed',1,$5,$6${validTraceParent(job.trace_parent) ? ',$7' : ''})`,
      [
        eventId,
        job.tenant_id,
        job.ticket_id,
        job.generation,
        payload,
        createHash('sha256').update(payload).digest(),
        ...(validTraceParent(job.trace_parent) ? [job.trace_parent] : []),
      ],
    );
  }
  async claim(): Promise<ExecutionClaim | null> {
    const startedAt = new Date();
    const claim = await this.claimTransaction();
    if (claim) {
      const span = this.telemetry.start(
        'job.claim',
        claim.traceParent,
        startedAt,
      );
      span.end('scheduled', {
        ticketId: claim.ticketId,
        attemptId: claim.attemptId,
        generation: claim.generation,
      });
      if (span.traceParent) claim.traceParent = span.traceParent;
    }
    return claim;
  }
  private claimTransaction(): Promise<ExecutionClaim | null> {
    return this.transaction(async (client) => {
      // Candidate discovery locks only the ticket first; competing workers skip
      // that ticket. Eligibility is rechecked after execution/job locks below.
      const candidate = (
        await client.query<{ id: string }>(`SELECT j.id FROM lab.tickets t
        JOIN lab.execution_jobs j ON j.tenant_id=t.tenant_id AND j.ticket_id=t.id AND j.generation=t.current_generation
        JOIN lab.ticket_executions e ON e.tenant_id=j.tenant_id AND e.ticket_id=j.ticket_id AND e.generation=j.generation
        WHERE (j.status='queued' AND e.status='queued' AND j.available_at<=clock_timestamp())
          OR (j.status='running' AND e.status='processing' AND j.lease_expires_at<=clock_timestamp())
        ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`)
      ).rows[0];
      if (!candidate) return null;
      const job = await this.lock(client, candidate.id);
      if (!job || job.current_generation !== job.generation) return null;
      const eligible =
        (
          await client.query(
            `SELECT id FROM lab.execution_jobs WHERE id=$1 AND
        ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_expires_at<=clock_timestamp()))`,
            [job.id],
          )
        ).rowCount === 1;
      if (
        !eligible ||
        !(
          (job.status === 'queued' && job.execution_status === 'queued') ||
          (job.status === 'running' && job.execution_status === 'processing')
        )
      )
        return null;
      if (job.status === 'running')
        await this.endAttempt(client, job, 'expired', 'LEASE_EXPIRED');
      if (job.attempt_count >= job.max_attempts) {
        await this.terminal(client, job, 'ATTEMPTS_EXHAUSTED');
        return null;
      }
      const token = randomUUID(),
        number = job.attempt_count + 1;
      await client.query(
        'INSERT INTO lab.execution_attempts(id,job_id,attempt_number) VALUES($1,$2,$3)',
        [token, job.id, number],
      );
      const lease = (
        await client.query<{ lease_expires_at: Date }>(
          "UPDATE lab.execution_jobs SET status='running',attempt_count=$2,attempt_id=$3,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 RETURNING lease_expires_at",
          [job.id, number, token],
        )
      ).rows[0]!.lease_expires_at;
      await client.query(
        "UPDATE lab.ticket_executions SET status='processing',updated_at=clock_timestamp() WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3",
        [job.tenant_id, job.ticket_id, job.generation],
      );
      return {
        ...(validTraceParent(job.trace_parent)
          ? { traceParent: job.trace_parent! }
          : {}),
        jobId: job.id,
        tenantId: job.tenant_id,
        ticketId: job.ticket_id,
        generation: job.generation,
        attemptId: token,
        attemptNumber: number,
        leaseExpiresAt: lease.toISOString(),
      };
    });
  }
  renew(jobId: string, attemptId: string): Promise<boolean> {
    this.validate(jobId, attemptId);
    return this.transaction(async (client) => {
      const job = await this.lock(client, jobId);
      if (!job || !(await this.owned(client, job, attemptId))) return false;
      return (
        (
          await client.query(
            "UPDATE lab.execution_jobs SET lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND attempt_id=$2 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING id",
            [jobId, attemptId],
          )
        ).rowCount === 1
      );
    }).then((saved) => {
      if (!saved) this.telemetry.increment?.('lease.renew');
      return saved;
    });
  }
  retry(jobId: string, attemptId: string): Promise<boolean> {
    return this.finish(jobId, attemptId, true).then((saved) => {
      if (!saved) this.telemetry.increment?.('lease.retry');
      return saved;
    });
  }
  complete(
    jobId: string,
    attemptId: string,
    input: unknown,
    parent?: string,
  ): Promise<boolean> {
    this.validate(jobId, attemptId);
    if (!resultSchema.safeParse(input).success)
      throw new ExecutionOwnershipError('INVALID_REQUEST');
    return this.traceResult(jobId, attemptId, input, parent);
  }
  private async traceResult(
    jobId: string,
    attemptId: string,
    input: unknown,
    parent?: string,
  ): Promise<boolean> {
    const span = this.telemetry.start('result.persist', parent);
    try {
      const saved = await this.persistResult(jobId, attemptId, input);
      span.end(saved ? 'completed' : 'stale', { attemptId });
      if (!saved) this.telemetry.increment?.('lease.complete');
      return saved;
    } catch (error) {
      span.end('failed', { attemptId });
      throw error;
    }
  }
  private persistResult(
    jobId: string,
    attemptId: string,
    input: unknown,
  ): Promise<boolean> {
    this.validate(jobId, attemptId);
    const result = resultSchema.safeParse(input);
    if (!result.success) throw new ExecutionOwnershipError('INVALID_REQUEST');
    return this.transaction(async (client) => {
      const job = await this.lock(client, jobId);
      if (!job || !(await this.owned(client, job, attemptId))) return false;
      for (const citation of result.data.citations) {
        const delivered = await client.query(
          'SELECT chunk_id FROM lab.execution_evidence WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3 AND attempt_id=$4 AND chunk_id=$5 AND document_id=$6 AND document_version=$7',
          [
            job.tenant_id,
            job.ticket_id,
            job.generation,
            attemptId,
            citation.chunkId,
            citation.documentId,
            citation.documentVersion,
          ],
        );
        if (delivered.rowCount !== 1)
          throw new ExecutionOwnershipError('INVALID_REQUEST');
      }
      await client.query(
        "INSERT INTO lab.execution_results(tenant_id,ticket_id,generation,job_id,attempt_id,attempt_count,outcome,answer,provider_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'simulated')",
        [
          job.tenant_id,
          job.ticket_id,
          job.generation,
          job.id,
          job.attempt_id,
          job.attempt_count,
          result.data.outcome,
          result.data.answer,
        ],
      );
      for (const [i, citation] of result.data.citations.entries())
        await client.query(
          'INSERT INTO lab.result_citations(tenant_id,ticket_id,generation,attempt_id,position,document_id,document_version,chunk_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            job.tenant_id,
            job.ticket_id,
            job.generation,
            attemptId,
            i + 1,
            citation.documentId,
            citation.documentVersion,
            citation.chunkId,
          ],
        );
      await this.endAttempt(client, job, 'succeeded', null);
      await client.query(
        "UPDATE lab.execution_jobs SET status='completed',attempt_id=NULL,lease_expires_at=NULL WHERE id=$1",
        [job.id],
      );
      await client.query(
        "UPDATE lab.ticket_executions SET status='completed',updated_at=clock_timestamp() WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3",
        [job.tenant_id, job.ticket_id, job.generation],
      );
      return true;
    });
  }
  fail(jobId: string, attemptId: string): Promise<boolean> {
    return this.finish(jobId, attemptId, false).then((saved) => {
      if (!saved) this.telemetry.increment?.('lease.fail');
      return saved;
    });
  }
  private validate(jobId: string, attemptId: string): void {
    if (!identity.safeParse([jobId, attemptId]).success)
      throw new ExecutionOwnershipError('INVALID_REQUEST');
  }
  private finish(
    jobId: string,
    attemptId: string,
    retry: boolean,
  ): Promise<boolean> {
    this.validate(jobId, attemptId);
    return this.transaction(async (client) => {
      const job = await this.lock(client, jobId);
      if (!job || !(await this.owned(client, job, attemptId))) return false;
      const exhausted = job.attempt_count >= job.max_attempts;
      if (!retry || exhausted) {
        const code = retry ? 'ATTEMPTS_EXHAUSTED' : 'EXECUTION_FAILED';
        await this.endAttempt(client, job, 'failed', code);
        await this.terminal(client, job, code);
      } else {
        await this.endAttempt(
          client,
          job,
          'retryable',
          'DEPENDENCY_UNAVAILABLE',
        );
        const delay = randomInt(
          Math.min(10000, 1000 * 2 ** (job.attempt_count - 1)) + 1,
        );
        await client.query(
          "UPDATE lab.execution_jobs SET status='queued',attempt_id=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+$2::int*interval '1 millisecond' WHERE id=$1",
          [job.id, delay],
        );
        await client.query(
          "UPDATE lab.ticket_executions SET status='queued',updated_at=clock_timestamp() WHERE tenant_id=$1 AND ticket_id=$2 AND generation=$3",
          [job.tenant_id, job.ticket_id, job.generation],
        );
      }
      return true;
    });
  }
}
