exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lab.tenant_corpus_profiles DROP CONSTRAINT tenant_corpus_profiles_policy_version_check,
      ADD CONSTRAINT tenant_corpus_profiles_policy_version_check CHECK(policy_version IN ('extractive-simulated-v1','bounded-agent-v1'));
    ALTER TABLE lab.execution_configurations DROP CONSTRAINT execution_configurations_policy_version_check,
      ADD CONSTRAINT execution_configurations_policy_version_check CHECK(policy_version IN ('extractive-simulated-v1','bounded-agent-v1'));
    CREATE FUNCTION lab.valid_agent_summary(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE call jsonb; turns integer;
    BEGIN
      IF value IS NULL THEN RETURN true; END IF;
      IF jsonb_typeof(value)<>'object' OR octet_length(value::text)>4096
        OR NOT value ?& ARRAY['policy','providerMode','modelTurns','toolCalls']
        OR (SELECT count(*) FROM jsonb_object_keys(value))<>4
        OR value->'policy' IS DISTINCT FROM '"bounded-agent-v1"'::jsonb OR value->'providerMode' IS DISTINCT FROM '"simulated"'::jsonb
        OR jsonb_typeof(value->'modelTurns')<>'number' OR (value->>'modelTurns')!~'^[1-4]$'
        OR jsonb_typeof(value->'toolCalls')<>'array' THEN RETURN false; END IF;
      turns:=(value->>'modelTurns')::integer;
      IF jsonb_array_length(value->'toolCalls')>3 OR jsonb_array_length(value->'toolCalls')>=turns THEN RETURN false; END IF;
      FOR call IN SELECT * FROM jsonb_array_elements(value->'toolCalls') LOOP
        IF jsonb_typeof(call)<>'object' OR NOT call ?& ARRAY['name','outcome']
          OR (SELECT count(*) FROM jsonb_object_keys(call))<>2
          OR jsonb_typeof(call->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(call->'outcome') IS DISTINCT FROM 'string'
          OR call->>'name' NOT IN ('search_documentation','get_service_status','get_ticket')
          OR call->>'outcome' NOT IN ('observed','not_found') THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    END $$;
    ALTER TABLE lab.execution_results ADD COLUMN agent_summary jsonb CHECK(lab.valid_agent_summary(agent_summary));
    GRANT INSERT(agent_summary) ON lab.execution_results TO lab_worker;
    GRANT SELECT(agent_summary) ON lab.execution_results TO lab_api;
    CREATE FUNCTION lab.check_agent_result_policy() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE policy text;
    BEGIN
      SELECT policy_version INTO policy FROM lab.execution_configurations
        WHERE tenant_id=NEW.tenant_id AND ticket_id=NEW.ticket_id AND generation=NEW.generation;
      IF (policy='bounded-agent-v1') IS TRUE AND NEW.agent_summary IS NULL
        OR (policy IS DISTINCT FROM 'bounded-agent-v1') AND NEW.agent_summary IS NOT NULL THEN
        RAISE EXCEPTION 'Result policy invariant violated' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER agent_result_policy AFTER INSERT OR UPDATE ON lab.execution_results
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lab.check_agent_result_policy();
  `);
};
exports.down = () => {
  throw Error('Agent results require a reviewed forward migration');
};
