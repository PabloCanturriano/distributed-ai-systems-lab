exports.up = (pgm) => {
  pgm.sql(`
    CREATE VIEW lab.operational_metrics WITH (security_barrier=true) AS
      SELECT 'outbox_pending'::text AS metric,type AS dimension,count(*)::double precision AS value
        FROM lab.outbox_events WHERE published_at IS NULL GROUP BY type
      UNION ALL SELECT 'outbox_oldest_seconds',type,
        greatest(0,extract(epoch FROM CURRENT_TIMESTAMP-min(created_at)))::double precision
        FROM lab.outbox_events WHERE published_at IS NULL GROUP BY type
      UNION ALL SELECT 'jobs',status,count(*)::double precision FROM lab.execution_jobs GROUP BY status
      UNION ALL SELECT 'queue_oldest_seconds','queued',
        coalesce(greatest(0,extract(epoch FROM CURRENT_TIMESTAMP-min(available_at))),0)::double precision
        FROM lab.execution_jobs WHERE status='queued' AND available_at<=CURRENT_TIMESTAMP
      UNION ALL SELECT 'expired_leases','running',count(*)::double precision
        FROM lab.execution_jobs WHERE status='running' AND lease_expires_at<=CURRENT_TIMESTAMP
      UNION ALL SELECT 'attempts',status,count(*)::double precision FROM lab.execution_attempts GROUP BY status
      UNION ALL SELECT 'quarantine',reason,count(*)::double precision FROM lab.event_quarantine GROUP BY reason;
    GRANT SELECT ON lab.operational_metrics TO lab_relay;
  `);
};
exports.down = () => {
  throw new Error('Operational metrics require a reviewed forward migration');
};
