-- Privileged one-shot setup for a dedicated lab database, not an application login.
SELECT pg_advisory_xact_lock(41017, 1);

DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['lab_migrator', 'lab_seed', 'lab_api', 'lab_worker', 'lab_relay']
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
    ELSIF EXISTS (
      SELECT FROM pg_roles WHERE rolname = role_name AND
        (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    ) THEN
      RAISE EXCEPTION 'Existing lab role has incompatible attributes';
    END IF;
    IF EXISTS (SELECT FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = role_name)) THEN
      RAISE EXCEPTION 'Existing lab role has unexpected memberships';
    END IF;
  END LOOP;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lab_migrator, lab_seed, lab_api, lab_worker, lab_relay', current_database());
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE SCHEMA IF NOT EXISTS lab AUTHORIZATION lab_migrator;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'lab' AND r.rolname = 'lab_migrator'
  ) THEN
    RAISE EXCEPTION 'Existing lab schema has incompatible ownership';
  END IF;
END $$;
REVOKE ALL ON SCHEMA lab FROM PUBLIC;
GRANT USAGE ON SCHEMA public, lab TO lab_seed, lab_api, lab_worker, lab_relay;
GRANT USAGE ON SCHEMA public TO lab_migrator;
