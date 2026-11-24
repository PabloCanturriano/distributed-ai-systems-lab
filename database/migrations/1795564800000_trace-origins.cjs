exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lab.outbox_events ADD COLUMN trace_parent text CHECK (
      trace_parent IS NULL OR (trace_parent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$'
        AND substring(trace_parent,4,32)<>repeat('0',32) AND substring(trace_parent,37,16)<>repeat('0',16))
    );
    ALTER TABLE lab.execution_jobs ADD COLUMN trace_parent text CHECK (
      trace_parent IS NULL OR (trace_parent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$'
        AND substring(trace_parent,4,32)<>repeat('0',32) AND substring(trace_parent,37,16)<>repeat('0',16))
    );
    GRANT INSERT(trace_parent) ON lab.outbox_events TO lab_api,lab_worker;
    GRANT INSERT(trace_parent) ON lab.execution_jobs TO lab_worker;
  `);
};
exports.down = () => {
  throw new Error(
    'Trace origins require an explicit forward migration; destructive rollback is unsupported',
  );
};
