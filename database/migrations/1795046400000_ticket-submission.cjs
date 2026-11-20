exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lab.tickets (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES lab.tenants(id),
      created_by uuid NOT NULL,
      message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
      current_generation integer NOT NULL CHECK (current_generation > 0),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT tickets_tenant_id_unique UNIQUE (tenant_id, id),
      CONSTRAINT tickets_creator_fk FOREIGN KEY (tenant_id, created_by)
        REFERENCES lab.principals(tenant_id, id)
    );
    CREATE TABLE lab.ticket_executions (
      tenant_id uuid NOT NULL,
      ticket_id uuid NOT NULL,
      generation integer NOT NULL CHECK (generation > 0),
      status text NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
      scheduling_reason text NOT NULL CHECK (scheduling_reason IN ('submitted','replayed')),
      requested_by uuid NOT NULL,
      correlation_id uuid NOT NULL,
      scheduling_event_id uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, ticket_id, generation),
      CONSTRAINT executions_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES lab.tickets(tenant_id, id),
      CONSTRAINT executions_requester_fk FOREIGN KEY (tenant_id, requested_by)
        REFERENCES lab.principals(tenant_id, id)
    );
    ALTER TABLE lab.tickets ADD CONSTRAINT tickets_current_execution_fk
      FOREIGN KEY (tenant_id, id, current_generation)
      REFERENCES lab.ticket_executions(tenant_id, ticket_id, generation)
      DEFERRABLE INITIALLY DEFERRED;
    CREATE TABLE lab.idempotency_records (
      tenant_id uuid NOT NULL,
      operation text NOT NULL CHECK (octet_length(operation) BETWEEN 1 AND 64),
      resource_scope text NOT NULL CHECK (octet_length(resource_scope) BETWEEN 1 AND 128),
      key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._-]{1,128}$'),
      request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
      ticket_id uuid NOT NULL,
      generation integer NOT NULL CHECK (generation > 0),
      receipt jsonb NOT NULL CHECK (receipt = jsonb_build_object(
        'ticketId',ticket_id,'generation',generation,'statusUrl','/v1/tickets/' || ticket_id)),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, operation, resource_scope, key),
      CONSTRAINT idempotency_execution_fk FOREIGN KEY (tenant_id, ticket_id, generation)
        REFERENCES lab.ticket_executions(tenant_id, ticket_id, generation)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE lab.outbox_events (
      event_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      ticket_id uuid NOT NULL,
      generation integer NOT NULL CHECK (generation > 0),
      type text NOT NULL CHECK (type IN ('ticket.execution.requested','ticket.execution.failed')),
      version integer NOT NULL CHECK (version = 1),
      payload text NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 16384),
      payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at timestamptz,
      CONSTRAINT outbox_execution_fk FOREIGN KEY (tenant_id, ticket_id, generation)
        REFERENCES lab.ticket_executions(tenant_id, ticket_id, generation),
      CONSTRAINT outbox_event_execution_unique UNIQUE (event_id, tenant_id, ticket_id, generation),
      CONSTRAINT outbox_envelope CHECK ((
        jsonb_typeof(payload::jsonb) = 'object' AND
        (payload::jsonb)->>'eventId' = event_id::text AND
        (payload::jsonb)->>'tenantId' = tenant_id::text AND
        (payload::jsonb)->>'ticketId' = ticket_id::text AND
        (payload::jsonb)->>'generation' = generation::text AND
        (payload::jsonb)->>'type' = type AND
        (payload::jsonb)->>'version' = version::text
      ) IS TRUE)
    );
    ALTER TABLE lab.ticket_executions ADD CONSTRAINT executions_scheduling_outbox_fk
      FOREIGN KEY (scheduling_event_id, tenant_id, ticket_id, generation)
      REFERENCES lab.outbox_events(event_id, tenant_id, ticket_id, generation)
      DEFERRABLE INITIALLY DEFERRED;
    GRANT SELECT ON lab.tickets, lab.ticket_executions,
      lab.idempotency_records, lab.outbox_events TO lab_api;
    GRANT INSERT (id,tenant_id,created_by,message,current_generation) ON lab.tickets TO lab_api;
    GRANT INSERT (tenant_id,ticket_id,generation,status,scheduling_reason,requested_by,correlation_id,scheduling_event_id)
      ON lab.ticket_executions TO lab_api;
    GRANT INSERT (tenant_id,operation,resource_scope,key,request_hash,ticket_id,generation,receipt)
      ON lab.idempotency_records TO lab_api;
    GRANT INSERT (event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest)
      ON lab.outbox_events TO lab_api;
  `);
};

exports.down = () => {
  throw new Error(
    'Ticket submission requires an explicit forward migration; destructive rollback is unsupported',
  );
};
