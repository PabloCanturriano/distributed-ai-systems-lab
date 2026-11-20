exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lab.consumer_inbox (
      consumer_name text NOT NULL CHECK (octet_length(consumer_name) BETWEEN 1 AND 128),
      event_id uuid NOT NULL,
      payload_digest bytea NOT NULL CHECK (octet_length(payload_digest)=32),
      tenant_id uuid NOT NULL,
      ticket_id uuid NOT NULL,
      generation integer NOT NULL CHECK (generation>0),
      disposition text NOT NULL CHECK (disposition IN ('scheduled','duplicate-generation','stale')),
      received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (consumer_name,event_id),
      UNIQUE (consumer_name,event_id,tenant_id,ticket_id,generation),
      FOREIGN KEY (tenant_id,ticket_id,generation)
        REFERENCES lab.ticket_executions(tenant_id,ticket_id,generation)
    );
    CREATE TABLE lab.execution_jobs (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      ticket_id uuid NOT NULL,
      generation integer NOT NULL CHECK (generation>0),
      consumer_name text NOT NULL,
      source_event_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'queued' CHECK (status='queued'),
      available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0 AND attempt_count<=max_attempts),
      max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts>0),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (ticket_id,generation),
      FOREIGN KEY (tenant_id,ticket_id,generation)
        REFERENCES lab.ticket_executions(tenant_id,ticket_id,generation),
      FOREIGN KEY (consumer_name,source_event_id,tenant_id,ticket_id,generation)
        REFERENCES lab.consumer_inbox(consumer_name,event_id,tenant_id,ticket_id,generation)
    );
    CREATE TABLE lab.event_quarantine (
      consumer_name text NOT NULL CHECK (octet_length(consumer_name) BETWEEN 1 AND 128),
      topic text NOT NULL CHECK (octet_length(topic) BETWEEN 1 AND 249),
      partition integer NOT NULL CHECK (partition>=0),
      "offset" bigint NOT NULL CHECK ("offset">=0),
      payload_digest bytea NOT NULL CHECK (octet_length(payload_digest)=32),
      reason text NOT NULL CHECK (reason IN (
        'INVALID_ENVELOPE','UNSUPPORTED_EVENT','EVENT_TOO_LARGE','KEY_MISMATCH',
        'UNKNOWN_TICKET','TENANT_MISMATCH','FUTURE_GENERATION','UNKNOWN_EXECUTION',
        'REASON_MISMATCH','EVENT_ID_COLLISION','EXECUTION_NOT_QUEUED'
      )),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (consumer_name,topic,partition,"offset")
    );
    GRANT SELECT (id,tenant_id,current_generation) ON lab.tickets TO lab_worker;
    -- PostgreSQL row locks require UPDATE on a column. Referencing execution
    -- FKs prevent renaming the ticket; no message/pointer UPDATE is granted.
    GRANT UPDATE (id) ON lab.tickets TO lab_worker;
    GRANT SELECT ON lab.ticket_executions,lab.consumer_inbox,lab.execution_jobs,lab.event_quarantine TO lab_worker;
    GRANT INSERT (consumer_name,event_id,payload_digest,tenant_id,ticket_id,generation,disposition)
      ON lab.consumer_inbox TO lab_worker;
    GRANT INSERT (id,tenant_id,ticket_id,generation,consumer_name,source_event_id)
      ON lab.execution_jobs TO lab_worker;
    GRANT INSERT (consumer_name,topic,partition,"offset",payload_digest,reason)
      ON lab.event_quarantine TO lab_worker;
  `);
};
exports.down = () => {
  throw new Error(
    'Scheduling admission requires an explicit forward migration; destructive rollback is unsupported',
  );
};
