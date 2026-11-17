exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lab.tenants (
      id uuid CONSTRAINT tenants_pk PRIMARY KEY,
      name text NOT NULL CONSTRAINT tenants_name_length CHECK (octet_length(name) BETWEEN 1 AND 256),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE lab.principals (
      id uuid CONSTRAINT principals_pk PRIMARY KEY,
      tenant_id uuid NOT NULL,
      role text NOT NULL CONSTRAINT principals_role_allowed CHECK (role IN ('reader', 'requester', 'operator')),
      disabled_at timestamptz,
      CONSTRAINT principals_tenant_fk FOREIGN KEY (tenant_id) REFERENCES lab.tenants(id),
      CONSTRAINT principals_tenant_id_unique UNIQUE (tenant_id, id)
    );
    CREATE TABLE lab.auth_credentials (
      id uuid CONSTRAINT auth_credentials_pk PRIMARY KEY,
      principal_id uuid NOT NULL,
      secret_digest bytea NOT NULL CONSTRAINT auth_credentials_digest_length CHECK (octet_length(secret_digest) = 32),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at timestamptz,
      revoked_at timestamptz,
      CONSTRAINT auth_credentials_principal_fk FOREIGN KEY (principal_id) REFERENCES lab.principals(id),
      CONSTRAINT auth_credentials_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
    );
    CREATE INDEX auth_credentials_principal_idx ON lab.auth_credentials(principal_id);
    GRANT SELECT ON lab.tenants, lab.principals, lab.auth_credentials TO lab_api;
    GRANT SELECT, INSERT ON lab.tenants, lab.principals, lab.auth_credentials TO lab_seed;
  `);
};

exports.down = () => {
  throw new Error(
    'Identity foundation requires an explicit forward migration; destructive rollback is unsupported',
  );
};
