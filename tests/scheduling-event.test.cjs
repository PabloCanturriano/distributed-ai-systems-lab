const { randomUUID } = require('node:crypto');
const {
  parseSchedulingEvent,
} = require('../apps/worker/dist/scheduling-event.js');
const {
  SchedulingAdmissions,
} = require('../apps/worker/dist/scheduling-admissions.js');
function fixture() {
  const ticketId = randomUUID();
  const body = {
    eventId: randomUUID(),
    tenantId: randomUUID(),
    ticketId,
    type: 'ticket.execution.requested',
    version: 1,
    generation: 1,
    occurredAt: '2026-11-20T12:00:00.000Z',
    correlationId: randomUUID(),
    causationId: randomUUID(),
    data: { reason: 'submitted' },
  };
  return {
    body,
    record: {
      topic: 'tickets.execution-requested.v1',
      partition: 0,
      offset: '0',
      key: Buffer.from(ticketId),
      value: Buffer.from(JSON.stringify(body)),
    },
  };
}
test('scheduling validation accepts bounded additive data without using it for admission', () => {
  const { body, record } = fixture();
  record.value = Buffer.from(
    JSON.stringify({
      ...body,
      future: { role: 'operator' },
      data: { ...body.data, future: 'ignored' },
    }),
  );
  expect(parseSchedulingEvent(record)).toEqual({
    eventId: body.eventId,
    tenantId: body.tenantId,
    ticketId: body.ticketId,
    generation: 1,
    reason: 'submitted',
  });
});
test.each([
  [null, 'INVALID_ENVELOPE'],
  [Buffer.from([0xff]), 'INVALID_ENVELOPE'],
  [Buffer.from('null'), 'INVALID_ENVELOPE'],
  [Buffer.from('[]'), 'INVALID_ENVELOPE'],
  [Buffer.alloc(16385, 32), 'EVENT_TOO_LARGE'],
])(
  'invalid bytes are rejected with a safe quarantine reason',
  (value, reason) => {
    const { record } = fixture();
    expect(parseSchedulingEvent({ ...record, value })).toBe(reason);
  },
);
test.each([
  { version: 2 },
  { type: 'ticket.execution.failed' },
  { eventId: 'invalid' },
  { generation: 0 },
  { generation: 2147483648 },
  { occurredAt: '2026-02-30T12:00:00Z' },
  { occurredAt: '2026-11-20' },
  { correlationId: null },
  { data: { reason: { toString: 'private-detail' } } },
])('invalid envelope cannot authorize scheduling', (fields) => {
  const { body, record } = fixture();
  record.value = Buffer.from(JSON.stringify({ ...body, ...fields }));
  expect(parseSchedulingEvent(record)).toBe(
    fields.version || fields.type ? 'UNSUPPORTED_EVENT' : 'INVALID_ENVELOPE',
  );
});
test('a partition key must identify the payload ticket', () => {
  const { record } = fixture();
  expect(parseSchedulingEvent({ ...record, key: null })).toBe('KEY_MISMATCH');
  expect(
    parseSchedulingEvent({ ...record, key: Buffer.from(randomUUID()) }),
  ).toBe('KEY_MISMATCH');
});
test.each(['-1', '01', '1.0', '9223372036854775808', '9007199254740993x'])(
  'an invalid source offset %s never reaches SQL',
  async (offset) => {
    const { record } = fixture();
    const pool = { connect: jest.fn() };
    await expect(
      new SchedulingAdmissions(pool).admit({ ...record, offset }),
    ).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    expect(pool.connect).not.toHaveBeenCalled();
  },
);
