import type { Pool } from 'pg';
import type { Telemetry } from '@lab/telemetry';
// A bounded periodic snapshot, never a query executed by an exporter callback.
export async function refreshOperationalMetrics(
  pool: Pick<Pool, 'connect'>,
  telemetry: Telemetry,
): Promise<void> {
  if (!telemetry.snapshot) return;
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(
      "SET LOCAL ROLE lab_relay; SET LOCAL statement_timeout='500ms'",
    );
    const result = await client.query<{
      metric: string;
      dimension: string;
      value: number;
    }>('SELECT metric,dimension,value FROM lab.operational_metrics');
    await client.query('COMMIT');
    telemetry.snapshot(result.rows);
  } catch (error) {
    discard = true;
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release(discard);
  }
}
