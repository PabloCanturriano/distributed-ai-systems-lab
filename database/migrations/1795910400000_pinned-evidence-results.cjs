exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lab.execution_configurations (
      tenant_id uuid NOT NULL,ticket_id uuid NOT NULL,generation integer NOT NULL,
      snapshot_id uuid NOT NULL,profile_id text NOT NULL,
      policy_version text NOT NULL CHECK(policy_version='extractive-simulated-v1'),
      provider_mode text NOT NULL CHECK(provider_mode='simulated'),
      PRIMARY KEY(tenant_id,ticket_id,generation),
      UNIQUE(tenant_id,ticket_id,generation,snapshot_id,profile_id),
      FOREIGN KEY(tenant_id,ticket_id,generation) REFERENCES lab.ticket_executions(tenant_id,ticket_id,generation),
      FOREIGN KEY(tenant_id,snapshot_id,profile_id) REFERENCES lab.corpus_snapshots(tenant_id,id,profile_id)
    );
    CREATE TABLE lab.execution_evidence (
      tenant_id uuid NOT NULL,ticket_id uuid NOT NULL,generation integer NOT NULL,
      job_id uuid NOT NULL,attempt_id uuid NOT NULL,attempt_number integer NOT NULL,
      position integer NOT NULL CHECK(position BETWEEN 1 AND 5),
      snapshot_id uuid NOT NULL,profile_id text NOT NULL,document_id uuid NOT NULL,document_version text NOT NULL,chunk_id uuid NOT NULL,
      PRIMARY KEY(tenant_id,ticket_id,generation,attempt_id,position),
      UNIQUE(tenant_id,ticket_id,generation,attempt_id,chunk_id,document_id,document_version),
      FOREIGN KEY(tenant_id,ticket_id,generation,snapshot_id,profile_id) REFERENCES lab.execution_configurations(tenant_id,ticket_id,generation,snapshot_id,profile_id),
      FOREIGN KEY(job_id,tenant_id,ticket_id,generation) REFERENCES lab.execution_jobs(id,tenant_id,ticket_id,generation),
      FOREIGN KEY(attempt_id,job_id,attempt_number) REFERENCES lab.execution_attempts(id,job_id,attempt_number),
      FOREIGN KEY(tenant_id,chunk_id,document_id,document_version) REFERENCES lab.document_chunks(tenant_id,id,document_id,document_version),
      FOREIGN KEY(tenant_id,snapshot_id,document_id,document_version) REFERENCES lab.corpus_snapshot_documents(tenant_id,snapshot_id,document_id,document_version),
      FOREIGN KEY(tenant_id,chunk_id,profile_id) REFERENCES lab.chunk_embeddings(tenant_id,chunk_id,profile_id)
    );
    ALTER TABLE lab.execution_results DROP CONSTRAINT execution_results_outcome_check,
      ADD CONSTRAINT execution_results_outcome_check CHECK(outcome IN ('answered','insufficient_evidence')),
      ADD CONSTRAINT execution_result_attempt_identity UNIQUE(tenant_id,ticket_id,generation,attempt_id);
    CREATE TABLE lab.result_citations (
      tenant_id uuid NOT NULL,ticket_id uuid NOT NULL,generation integer NOT NULL,attempt_id uuid NOT NULL,
      position integer NOT NULL CHECK(position BETWEEN 1 AND 5),document_id uuid NOT NULL,document_version text NOT NULL,chunk_id uuid NOT NULL,
      PRIMARY KEY(tenant_id,ticket_id,generation,position),UNIQUE(tenant_id,ticket_id,generation,chunk_id),
      FOREIGN KEY(tenant_id,ticket_id,generation,attempt_id) REFERENCES lab.execution_results(tenant_id,ticket_id,generation,attempt_id),
      FOREIGN KEY(tenant_id,ticket_id,generation,attempt_id,chunk_id,document_id,document_version)
        REFERENCES lab.execution_evidence(tenant_id,ticket_id,generation,attempt_id,chunk_id,document_id,document_version)
    );
    CREATE FUNCTION lab.check_result_citations() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE result_outcome text; citation_count integer;
    BEGIN
      SELECT outcome INTO result_outcome FROM lab.execution_results
        WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id) AND ticket_id=COALESCE(NEW.ticket_id,OLD.ticket_id) AND generation=COALESCE(NEW.generation,OLD.generation);
      IF result_outcome IS NOT NULL THEN
        SELECT count(*) INTO citation_count FROM lab.result_citations
          WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id) AND ticket_id=COALESCE(NEW.ticket_id,OLD.ticket_id) AND generation=COALESCE(NEW.generation,OLD.generation);
        IF (result_outcome='answered' AND citation_count=0) OR (result_outcome='insufficient_evidence' AND citation_count<>0) THEN
          RAISE EXCEPTION 'Result citation invariant violated' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER result_requires_citations AFTER INSERT OR UPDATE ON lab.execution_results
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lab.check_result_citations();
    CREATE CONSTRAINT TRIGGER citation_result_consistency AFTER INSERT OR UPDATE OR DELETE ON lab.result_citations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lab.check_result_citations();
    GRANT SELECT ON lab.execution_configurations TO lab_api,lab_worker;
    GRANT INSERT ON lab.execution_configurations TO lab_api;
    GRANT SELECT(message) ON lab.tickets TO lab_worker;
    GRANT SELECT,INSERT ON lab.execution_evidence TO lab_worker;
    GRANT SELECT,INSERT ON lab.result_citations TO lab_worker;
    GRANT SELECT ON lab.result_citations TO lab_api;
  `);
};
exports.down = () => {
  throw new Error('Pinned evidence requires a reviewed forward migration');
};
