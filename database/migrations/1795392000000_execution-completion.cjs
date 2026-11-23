exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lab.execution_jobs DROP CONSTRAINT execution_jobs_status_check,
      ADD CONSTRAINT execution_jobs_status_check CHECK (status IN ('queued','running','failed','completed')),
      ADD CONSTRAINT execution_job_result_identity UNIQUE(id,tenant_id,ticket_id,generation);
    ALTER TABLE lab.execution_attempts DROP CONSTRAINT execution_attempts_status_check,
      ADD CONSTRAINT execution_attempts_status_check CHECK (status IN ('running','expired','retryable','failed','succeeded')),
      DROP CONSTRAINT execution_attempt_outcome,
      ADD CONSTRAINT execution_attempt_outcome CHECK ((
        (status='running' AND finished_at IS NULL AND failure_code IS NULL) OR
        (status='succeeded' AND finished_at IS NOT NULL AND failure_code IS NULL) OR
        (status='expired' AND finished_at IS NOT NULL AND failure_code='LEASE_EXPIRED') OR
        (status='retryable' AND finished_at IS NOT NULL AND failure_code='DEPENDENCY_UNAVAILABLE') OR
        (status='failed' AND finished_at IS NOT NULL AND failure_code IN ('EXECUTION_FAILED','ATTEMPTS_EXHAUSTED'))
      ) IS TRUE);
    CREATE TABLE lab.execution_results (
      tenant_id uuid NOT NULL,
      ticket_id uuid NOT NULL,
      generation integer NOT NULL CHECK (generation>0),
      job_id uuid NOT NULL UNIQUE,
      attempt_id uuid NOT NULL,
      attempt_count integer NOT NULL CHECK (attempt_count>0),
      outcome text NOT NULL CHECK (outcome='insufficient_evidence'),
      answer text NOT NULL CHECK (octet_length(answer) BETWEEN 1 AND 8192 AND length(btrim(answer))>0),
      provider_mode text NOT NULL CHECK (provider_mode='simulated'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,ticket_id,generation),
      FOREIGN KEY(tenant_id,ticket_id,generation) REFERENCES lab.ticket_executions(tenant_id,ticket_id,generation),
      FOREIGN KEY(job_id,tenant_id,ticket_id,generation) REFERENCES lab.execution_jobs(id,tenant_id,ticket_id,generation),
      FOREIGN KEY(attempt_id,job_id,attempt_count) REFERENCES lab.execution_attempts(id,job_id,attempt_number)
    );
    GRANT SELECT ON lab.execution_results TO lab_worker;
    GRANT INSERT(tenant_id,ticket_id,generation,job_id,attempt_id,attempt_count,outcome,answer,provider_mode)
      ON lab.execution_results TO lab_worker;
    GRANT SELECT(tenant_id,ticket_id,generation,status,failure_code,attempt_count)
      ON lab.execution_jobs TO lab_api;
    GRANT SELECT(tenant_id,ticket_id,generation,outcome,answer,provider_mode,attempt_count)
      ON lab.execution_results TO lab_api;
  `);
};
exports.down = () => {
  throw new Error(
    'Execution completion requires an explicit forward migration; destructive rollback is unsupported',
  );
};
