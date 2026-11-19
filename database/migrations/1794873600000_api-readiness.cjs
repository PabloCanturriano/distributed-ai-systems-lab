exports.up = (pgm) => {
  pgm.sql(`
    CREATE VIEW lab.api_readiness AS
    SELECT 1::int AS contract_version,
      EXISTS (
        SELECT FROM lab.seed_manifests WHERE name='identities-v1'
          AND fixture_digest=decode('871e76601cc68a3b628ec601ce352d0f66ceccadce23590780899da09eb1b37a','hex')
      ) AS identities_ready;
    GRANT SELECT ON lab.api_readiness TO lab_api;
  `);
};
exports.down = () => {
  throw new Error('API readiness requires an explicit forward migration');
};
