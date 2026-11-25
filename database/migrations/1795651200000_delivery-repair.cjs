exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lab.environment_identity (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO lab.environment_identity(singleton) VALUES(true);
    CREATE TABLE lab.delivery_repairs (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      ticket_id uuid NOT NULL,
      generation integer NOT NULL CHECK(generation>0),
      operation text NOT NULL DEFAULT 'tickets:delivery-repair:v1' CHECK(operation='tickets:delivery-repair:v1'),
      resource_scope text NOT NULL CHECK(resource_scope=ticket_id::text),
      key text NOT NULL,
      previous_event_id uuid NOT NULL,
      new_event_id uuid NOT NULL UNIQUE,
      source_consumer text NOT NULL CHECK(source_consumer='ticket-scheduler.v1'),
      source_topic text NOT NULL CHECK(source_topic='tickets.execution-requested.v1'),
      source_partition integer NOT NULL,
      source_offset bigint NOT NULL,
      source_digest bytea NOT NULL CHECK(octet_length(source_digest)=32),
      reason text NOT NULL CHECK(reason IN ('SCHEMA_CORRECTED','SOURCE_CORRECTED','DELIVERY_RECOVERY')),
      actor_database_role text NOT NULL CHECK(octet_length(actor_database_role) BETWEEN 1 AND 128),
      request_id uuid NOT NULL,
      environment_id uuid NOT NULL REFERENCES lab.environment_identity(id),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id,operation,resource_scope,key),
      CHECK(previous_event_id<>new_event_id),
      FOREIGN KEY(tenant_id,operation,resource_scope,key) REFERENCES lab.idempotency_records(tenant_id,operation,resource_scope,key),
      FOREIGN KEY(tenant_id,ticket_id,generation) REFERENCES lab.ticket_executions(tenant_id,ticket_id,generation),
      FOREIGN KEY(previous_event_id,tenant_id,ticket_id,generation) REFERENCES lab.outbox_events(event_id,tenant_id,ticket_id,generation),
      FOREIGN KEY(new_event_id,tenant_id,ticket_id,generation) REFERENCES lab.outbox_events(event_id,tenant_id,ticket_id,generation),
      FOREIGN KEY(source_consumer,source_topic,source_partition,source_offset) REFERENCES lab.event_quarantine(consumer_name,topic,partition,"offset")
    );
    GRANT SELECT ON lab.environment_identity,lab.delivery_repairs,lab.event_quarantine,lab.idempotency_records TO lab_operations;
    GRANT SELECT(id,tenant_id,current_generation) ON lab.tickets TO lab_operations;
    GRANT UPDATE(id) ON lab.tickets TO lab_operations;
    GRANT SELECT(tenant_id,ticket_id,generation,status,scheduling_reason,correlation_id,scheduling_event_id) ON lab.ticket_executions TO lab_operations;
    GRANT UPDATE(scheduling_event_id) ON lab.ticket_executions TO lab_operations;
    GRANT SELECT(id,tenant_id,ticket_id,generation,status,source_event_id) ON lab.execution_jobs TO lab_operations;
    GRANT INSERT(event_id,tenant_id,ticket_id,generation,type,version,payload,payload_digest) ON lab.outbox_events TO lab_operations;
    GRANT INSERT(tenant_id,operation,resource_scope,key,request_hash,ticket_id,generation,receipt) ON lab.idempotency_records TO lab_operations;
    GRANT INSERT(id,tenant_id,ticket_id,generation,operation,resource_scope,key,previous_event_id,new_event_id,source_consumer,source_topic,source_partition,source_offset,source_digest,reason,actor_database_role,request_id,environment_id) ON lab.delivery_repairs TO lab_operations;
  `);
};
exports.down = () => {
  throw new Error(
    'Delivery repair requires a reviewed forward migration; destructive rollback is unsupported',
  );
};
