import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { TicketSubmissions, type TicketReceipt } from './ticket-submission';
import { TicketReads, type TicketStatus } from './ticket-read';

export interface TicketIdentity {
  tenantId: string;
  principalId: string;
  role: 'reader' | 'requester' | 'operator';
}
export class TicketAccessError extends Error {
  constructor(
    readonly code:
      'UNAUTHENTICATED' | 'RATE_LIMITED' | 'DEPENDENCY_UNAVAILABLE',
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = 'TicketAccessError';
  }
}
export interface SubmissionLimits {
  consume(scopes: Array<{ key: string; limit: number }>): Promise<void>;
}
export interface TicketService {
  checkIngress(peer: string): Promise<void>;
  authenticate(authorization: string | undefined): Promise<TicketIdentity>;
  checkSubmissionLimit(identity: TicketIdentity): Promise<void>;
  checkReadLimit(identity: TicketIdentity): Promise<void>;
  getTicket(identity: TicketIdentity, ticketId: string): Promise<TicketStatus>;
  submit(input: unknown): Promise<TicketReceipt>;
}
const lookupSchema = z.uuid();
const roleSchema = z.enum(['reader', 'requester', 'operator']);
const opaqueKey = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export class TicketAccess implements TicketService {
  private readonly submissions: TicketSubmissions;
  private readonly reads: TicketReads;
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly limits: SubmissionLimits,
  ) {
    this.submissions = new TicketSubmissions(pool);
    this.reads = new TicketReads(pool);
  }
  checkIngress(peer: string): Promise<void> {
    return this.limits.consume([
      { key: `ingress:${opaqueKey(peer)}`, limit: 300 },
    ]);
  }
  checkSubmissionLimit(identity: TicketIdentity): Promise<void> {
    return this.limits.consume([
      {
        key: `principal:${opaqueKey(`${identity.tenantId}:${identity.principalId}`)}`,
        limit: 120,
      },
      { key: `submission:${identity.tenantId}`, limit: 10 },
    ]);
  }
  submit(input: unknown): Promise<TicketReceipt> {
    return this.submissions.submit(input);
  }
  checkReadLimit(identity: TicketIdentity): Promise<void> {
    return this.limits.consume([
      {
        key: `principal:${opaqueKey(`${identity.tenantId}:${identity.principalId}`)}`,
        limit: 120,
      },
    ]);
  }
  getTicket(identity: TicketIdentity, ticketId: string): Promise<TicketStatus> {
    return this.reads.get({
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      ticketId,
    });
  }

  async authenticate(
    authorization: string | undefined,
  ): Promise<TicketIdentity> {
    const token = authorization?.match(
      /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i,
    );
    if (!token || !lookupSchema.safeParse(token[1]).success)
      throw new TicketAccessError('UNAUTHENTICATED');
    const secret = Buffer.from(token[2]!, 'base64url');
    if (secret.length !== 32 || secret.toString('base64url') !== token[2])
      throw new TicketAccessError('UNAUTHENTICATED');
    const digest = createHash('sha256').update(secret).digest();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new TicketAccessError('DEPENDENCY_UNAVAILABLE');
    }
    let discard = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL ROLE lab_api');
      const result = await client.query<{
        secret_digest: Buffer;
        tenant_id: string;
        principal_id: string;
        role: string;
      }>(
        `SELECT c.secret_digest,p.tenant_id,p.id AS principal_id,p.role FROM lab.auth_credentials c
         JOIN lab.principals p ON p.id=c.principal_id
         WHERE c.id=$1 AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>CURRENT_TIMESTAMP)
         AND p.disabled_at IS NULL`,
        [token[1]!.toLowerCase()],
      );
      const row = result.rows[0];
      const expected = row?.secret_digest ?? Buffer.alloc(32);
      const matches =
        expected.length === 32 && timingSafeEqual(digest, expected);
      if (!row || !matches) throw new TicketAccessError('UNAUTHENTICATED');
      const identity = {
        tenantId: row.tenant_id,
        principalId: row.principal_id,
        role: roleSchema.parse(row.role),
      };
      await client.query('COMMIT');
      return identity;
    } catch (error) {
      discard = !(error instanceof TicketAccessError);
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      if (error instanceof TicketAccessError) throw error;
      throw new TicketAccessError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
}
