exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lab.retrieval_profiles (
      id text PRIMARY KEY CHECK(id='lexical-hash-v1'),
      dimensions integer NOT NULL CHECK(dimensions=128),
      preprocessing text NOT NULL CHECK(preprocessing='ascii-sha256-count-l2-v1'),
      distance text NOT NULL CHECK(distance='cosine')
    );
    INSERT INTO lab.retrieval_profiles VALUES('lexical-hash-v1',128,'ascii-sha256-count-l2-v1','cosine');
    CREATE TABLE lab.documents (
      tenant_id uuid NOT NULL REFERENCES lab.tenants(id), id uuid NOT NULL,
      PRIMARY KEY(tenant_id,id)
    );
    CREATE TABLE lab.document_versions (
      tenant_id uuid NOT NULL,document_id uuid NOT NULL,version text NOT NULL CHECK(version ~ '^[A-Za-z0-9._-]{1,64}$'),
      title text NOT NULL CHECK(octet_length(title) BETWEEN 1 AND 200),
      source_text text NOT NULL CHECK(octet_length(source_text) BETWEEN 1 AND 65536),
      content_digest bytea NOT NULL CHECK(octet_length(content_digest)=32),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(tenant_id,document_id,version),
      FOREIGN KEY(tenant_id,document_id) REFERENCES lab.documents(tenant_id,id)
    );
    CREATE TABLE lab.document_chunks (
      tenant_id uuid NOT NULL,id uuid NOT NULL,document_id uuid NOT NULL,document_version text NOT NULL,
      ordinal integer NOT NULL CHECK(ordinal>=0),content text NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 2048),
      content_digest bytea NOT NULL CHECK(octet_length(content_digest)=32),
      PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,document_id,document_version,ordinal),
      UNIQUE(tenant_id,id,document_id,document_version),
      FOREIGN KEY(tenant_id,document_id,document_version) REFERENCES lab.document_versions(tenant_id,document_id,version)
    );
    CREATE TABLE lab.chunk_embeddings (
      tenant_id uuid NOT NULL,chunk_id uuid NOT NULL,profile_id text NOT NULL REFERENCES lab.retrieval_profiles(id),
      embedding public.vector(128) NOT NULL CHECK(public.vector_norm(embedding)>0),
      PRIMARY KEY(tenant_id,chunk_id,profile_id),
      FOREIGN KEY(tenant_id,chunk_id) REFERENCES lab.document_chunks(tenant_id,id)
    );
    CREATE TABLE lab.corpus_snapshots (
      tenant_id uuid NOT NULL REFERENCES lab.tenants(id),id uuid NOT NULL,version text NOT NULL CHECK(version ~ '^[A-Za-z0-9._-]{1,64}$'),
      manifest_digest bytea NOT NULL CHECK(octet_length(manifest_digest)=32),
      profile_id text NOT NULL REFERENCES lab.retrieval_profiles(id),
      chunking_profile text NOT NULL CHECK(chunking_profile='paragraph-utf8-v1'),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,id,profile_id)
    );
    CREATE TABLE lab.corpus_snapshot_documents (
      tenant_id uuid NOT NULL,snapshot_id uuid NOT NULL,document_id uuid NOT NULL,document_version text NOT NULL,
      PRIMARY KEY(tenant_id,snapshot_id,document_id,document_version),
      FOREIGN KEY(tenant_id,snapshot_id) REFERENCES lab.corpus_snapshots(tenant_id,id),
      FOREIGN KEY(tenant_id,document_id,document_version) REFERENCES lab.document_versions(tenant_id,document_id,version)
    );
    CREATE TABLE lab.tenant_corpus_profiles (
      tenant_id uuid PRIMARY KEY REFERENCES lab.tenants(id),snapshot_id uuid NOT NULL,profile_id text NOT NULL,
      policy_version text NOT NULL CHECK(policy_version='extractive-simulated-v1'),
      provider_mode text NOT NULL CHECK(provider_mode='simulated'),
      FOREIGN KEY(tenant_id,snapshot_id,profile_id) REFERENCES lab.corpus_snapshots(tenant_id,id,profile_id)
    );
    GRANT SELECT ON lab.retrieval_profiles,lab.documents,lab.document_versions,lab.document_chunks,lab.chunk_embeddings,
      lab.corpus_snapshots,lab.corpus_snapshot_documents,lab.tenant_corpus_profiles TO lab_seed,lab_worker;
    GRANT SELECT ON lab.tenant_corpus_profiles,lab.corpus_snapshots TO lab_api;
    GRANT INSERT ON lab.documents,lab.document_versions,lab.document_chunks,lab.chunk_embeddings,
      lab.corpus_snapshots,lab.corpus_snapshot_documents,lab.tenant_corpus_profiles TO lab_seed;
    GRANT UPDATE(snapshot_id,profile_id,policy_version,provider_mode) ON lab.tenant_corpus_profiles TO lab_seed;
  `);
};
exports.down = () => {
  throw new Error('Immutable corpus requires a reviewed forward migration');
};
