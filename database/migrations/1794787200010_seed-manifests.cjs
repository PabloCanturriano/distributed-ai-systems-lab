exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lab.seed_manifests (
      name text CONSTRAINT seed_manifests_pk PRIMARY KEY
        CONSTRAINT seed_manifests_name_length CHECK (octet_length(name) BETWEEN 1 AND 64),
      fixture_digest bytea NOT NULL CONSTRAINT seed_manifests_fixture_digest_length CHECK (octet_length(fixture_digest) = 32),
      credentials_digest bytea NOT NULL CONSTRAINT seed_manifests_credentials_digest_length CHECK (octet_length(credentials_digest) = 32),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    GRANT SELECT, INSERT ON lab.seed_manifests TO lab_seed;
  `);
};
exports.down = () => {
  throw new Error(
    'Seed manifests require an explicit forward migration; destructive rollback is unsupported',
  );
};
