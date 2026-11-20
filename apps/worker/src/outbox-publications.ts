import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface OutboxClaim {
  eventId: string;
  ticketId: string;
  type: string;
  version: number;
  payload: string;
  payloadDigest: Buffer;
  token: string;
}
export class OutboxPublicationError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'DEPENDENCY_UNAVAILABLE') {
    super(code);
    this.name = 'OutboxPublicationError';
  }
}
export class OutboxPublications {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  private async transaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new OutboxPublicationError('DEPENDENCY_UNAVAILABLE');
    }
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(
        "SET LOCAL ROLE lab_relay; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
      );
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch {
      discard = true;
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Destroy the uncertain connection below. */
      }
      throw new OutboxPublicationError('DEPENDENCY_UNAVAILABLE');
    } finally {
      client.release(discard);
    }
  }
  claim(limit = 20): Promise<OutboxClaim[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new OutboxPublicationError('INVALID_REQUEST');
    const token = randomUUID();
    return this.transaction(async (client) => {
      const result = await client.query<{
        event_id: string;
        ticket_id: string;
        type: string;
        version: number;
        payload: string;
        payload_digest: Buffer;
        claim_token: string;
      }>(
        `WITH candidates AS (
          SELECT event_id FROM lab.outbox_events WHERE published_at IS NULL AND available_at<=clock_timestamp()
          AND (claim_token IS NULL OR claim_expires_at<=clock_timestamp())
          ORDER BY available_at,event_id FOR UPDATE SKIP LOCKED LIMIT $1
        ) UPDATE lab.outbox_events o SET claim_token=$2,claim_expires_at=clock_timestamp()+interval '30 seconds',
          publication_attempts=publication_attempts+1,last_error_code=NULL
          FROM candidates c WHERE o.event_id=c.event_id
          RETURNING o.event_id,o.ticket_id,o.type,o.version,o.payload,o.payload_digest,o.claim_token`,
        [limit, token],
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        ticketId: row.ticket_id,
        type: row.type,
        version: row.version,
        payload: row.payload,
        payloadDigest: row.payload_digest,
        token: row.claim_token,
      }));
    });
  }
  isCurrent(eventId: string, token: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(
        'SELECT event_id FROM lab.outbox_events WHERE event_id=$1 AND claim_token=$2 AND published_at IS NULL AND claim_expires_at>clock_timestamp()',
        [eventId, token],
      );
      return result.rowCount === 1;
    });
  }
  acknowledge(eventId: string, token: string): Promise<boolean> {
    return this.finish(eventId, token);
  }
  retry(
    eventId: string,
    token: string,
    code: 'PUBLISH_FAILED' | 'INVALID_EVENT' = 'PUBLISH_FAILED',
  ): Promise<boolean> {
    if (!['PUBLISH_FAILED', 'INVALID_EVENT'].includes(code))
      throw new OutboxPublicationError('INVALID_REQUEST');
    return this.finish(eventId, token, code);
  }
  private finish(
    eventId: string,
    token: string,
    errorCode?: 'PUBLISH_FAILED' | 'INVALID_EVENT',
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      // Acquire the row lock before evaluating database-time ownership, including
      // when a competing transaction held the unchanged row through lease expiry.
      await client.query(
        'SELECT event_id FROM lab.outbox_events WHERE event_id=$1 FOR UPDATE',
        [eventId],
      );
      const result = await client.query(
        errorCode
          ? `UPDATE lab.outbox_events SET claim_token=NULL,claim_expires_at=NULL,
          available_at=clock_timestamp()+interval '1 second',last_error_code=$3
          WHERE event_id=$1 AND claim_token=$2 AND published_at IS NULL AND claim_expires_at>clock_timestamp() RETURNING event_id`
          : `UPDATE lab.outbox_events SET published_at=clock_timestamp(),claim_token=NULL,claim_expires_at=NULL,last_error_code=NULL
          WHERE event_id=$1 AND claim_token=$2 AND published_at IS NULL AND claim_expires_at>clock_timestamp() RETURNING event_id`,
        errorCode ? [eventId, token, errorCode] : [eventId, token],
      );
      return result.rowCount === 1;
    });
  }
}
