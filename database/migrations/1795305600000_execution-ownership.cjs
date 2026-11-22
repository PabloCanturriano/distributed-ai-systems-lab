exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lab.execution_jobs
      DROP CONSTRAINT execution_jobs_status_check,
      ADD CONSTRAINT execution_jobs_status_check CHECK (status IN ('queued','running','failed')),
      ADD COLUMN attempt_id uuid,
      ADD COLUMN lease_expires_at timestamptz,
      ADD COLUMN failure_code text CHECK (failure_code IN ('EXECUTION_FAILED','ATTEMPTS_EXHAUSTED')),
      ADD COLUMN failed_at timestamptz,
      ADD CONSTRAINT execution_job_lease_pair CHECK ((attempt_id IS NULL)=(lease_expires_at IS NULL)),
      ADD CONSTRAINT execution_job_running_lease CHECK ((status='running')=(attempt_id IS NOT NULL)),
      ADD CONSTRAINT execution_job_failure_pair CHECK ((failure_code IS NULL)=(failed_at IS NULL)),
      ADD CONSTRAINT execution_job_failed_state CHECK ((status='failed')=(failure_code IS NOT NULL)),
      ADD CONSTRAINT execution_job_started_budget CHECK (status='queued' OR attempt_count>0);
    CREATE TABLE lab.execution_attempts (
      id uuid PRIMARY KEY,
      job_id uuid NOT NULL REFERENCES lab.execution_jobs(id),
      attempt_number integer NOT NULL CHECK (attempt_number>0),
      status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','expired','retryable','failed')),
      started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      finished_at timestamptz,
      failure_code text,
      UNIQUE(job_id,attempt_number),
      UNIQUE(id,job_id,attempt_number),
      CONSTRAINT execution_attempt_outcome CHECK ((
        (status='running' AND finished_at IS NULL AND failure_code IS NULL) OR
        (status='expired' AND finished_at IS NOT NULL AND failure_code='LEASE_EXPIRED') OR
        (status='retryable' AND finished_at IS NOT NULL AND failure_code='DEPENDENCY_UNAVAILABLE') OR
        (status='failed' AND finished_at IS NOT NULL AND failure_code IN ('EXECUTION_FAILED','ATTEMPTS_EXHAUSTED'))
      ) IS TRUE)
    );
    ALTER TABLE lab.execution_jobs ADD CONSTRAINT execution_job_attempt_fk
      FOREIGN KEY(attempt_id,id,attempt_count) REFERENCES lab.execution_attempts(id,job_id,attempt_number);
    CREATE INDEX execution_jobs_queued_idx ON lab.execution_jobs(available_at,id) WHERE status='queued';
    CREATE INDEX execution_jobs_expired_idx ON lab.execution_jobs(lease_expires_at,id) WHERE status='running';
    CREATE UNIQUE INDEX outbox_terminal_failure_unique ON lab.outbox_events(tenant_id,ticket_id,generation)
      WHERE type='ticket.execution.failed';
    GRANT SELECT ON lab.execution_attempts TO lab_worker;
    GRANT INSERT(id,job_id,attempt_number) ON lab.execution_attempts TO lab_worker;
    GRANT UPDATE(status,finished_at,failure_code) ON lab.execution_attempts TO lab_worker;
    GRANT UPDATE(status,available_at,attempt_count,attempt_id,lease_expires_at,failure_code,failed_at)
      ON lab.execution_jobs TO lab_worker;
    GRANT UPDATE(status,updated_at) ON lab.ticket_executions TO lab_worker;
    GRANT INSERT(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest)
      ON lab.outbox_events TO lab_worker;
  `);
};
exports.down = () => {
  throw new Error(
    'Execution ownership requires an explicit forward migration; destructive rollback is unsupported',
  );
};
