exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lab.outbox_events
      ADD COLUMN available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN claim_token uuid,
      ADD COLUMN claim_expires_at timestamptz,
      ADD COLUMN publication_attempts integer NOT NULL DEFAULT 0 CHECK (publication_attempts >= 0),
      ADD COLUMN last_error_code text CHECK (last_error_code IN ('PUBLISH_FAILED','INVALID_EVENT')),
      ADD CONSTRAINT outbox_claim_pair CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
      ADD CONSTRAINT outbox_published_unclaimed CHECK (published_at IS NULL OR (claim_token IS NULL AND claim_expires_at IS NULL));
    CREATE INDEX outbox_pending_available_idx ON lab.outbox_events(available_at,event_id) WHERE published_at IS NULL;
    GRANT SELECT ON lab.outbox_events TO lab_relay;
    GRANT UPDATE (available_at,claim_token,claim_expires_at,publication_attempts,last_error_code,published_at)
      ON lab.outbox_events TO lab_relay;
  `);
};
exports.down = () => {
  throw new Error(
    'Outbox publication requires an explicit forward migration; destructive rollback is unsupported',
  );
};
