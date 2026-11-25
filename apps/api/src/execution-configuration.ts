import type { PoolClient } from 'pg';
// Only new generations select the active configuration. Historical receipts and
// retries never resolve an active pointer again.
export async function pinExecutionConfiguration(
  client: PoolClient,
  tenantId: string,
  ticketId: string,
  generation: number,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO lab.execution_configurations(tenant_id,ticket_id,generation,snapshot_id,profile_id,policy_version,provider_mode)
    SELECT tenant_id,$2,$3,snapshot_id,profile_id,policy_version,provider_mode FROM lab.tenant_corpus_profiles WHERE tenant_id=$1 RETURNING snapshot_id`,
    [tenantId, ticketId, generation],
  );
  if (inserted.rowCount !== 1)
    throw Error('Execution configuration unavailable');
}
