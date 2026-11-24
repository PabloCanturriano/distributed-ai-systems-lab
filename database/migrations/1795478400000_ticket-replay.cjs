exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lab.audit_records (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      principal_id uuid NOT NULL,
      ticket_id uuid NOT NULL,
      generation integer NOT NULL,
      previous_generation integer NOT NULL CHECK (previous_generation>0 AND generation=previous_generation+1),
      action text NOT NULL CHECK (action='ticket.replayed'),
      request_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(tenant_id,principal_id) REFERENCES lab.principals(tenant_id,id),
      FOREIGN KEY(tenant_id,ticket_id,generation) REFERENCES lab.ticket_executions(tenant_id,ticket_id,generation),
      FOREIGN KEY(tenant_id,ticket_id,previous_generation) REFERENCES lab.ticket_executions(tenant_id,ticket_id,generation),
      UNIQUE(tenant_id,ticket_id,generation,action)
    );
    GRANT INSERT(id,tenant_id,principal_id,ticket_id,generation,previous_generation,action,request_id)
      ON lab.audit_records TO lab_api;
    GRANT UPDATE(current_generation,updated_at) ON lab.tickets TO lab_api;
  `);
};
exports.down = () => {
  throw new Error(
    'Ticket replay requires an explicit forward migration; destructive rollback is unsupported',
  );
};
