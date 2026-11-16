const {
  loadApiConfiguration,
  loadWorkerConfiguration,
} = require('@lab/configuration');

test('absent settings select local mode and loopback without mutating the environment', () => {
  const environment = Object.freeze({ UNRELATED_SETTING: 'ignored' });
  expect(loadApiConfiguration(environment)).toEqual({
    mode: 'local',
    host: '127.0.0.1',
    port: 3000,
  });
  expect(loadWorkerConfiguration(environment)).toEqual({ mode: 'local' });
});

test.each(['1', '3001', '65535'])(
  'API accepts TCP port %s as a number',
  (port) => {
    expect(loadApiConfiguration({ API_PORT: port }).port).toBe(Number(port));
  },
);

test.each([
  '',
  '0',
  '-1',
  '65536',
  '03000',
  '3e3',
  '3000.0',
  ' 3000',
  '3000 ',
  'NaN',
  '9'.repeat(100),
])(
  'API rejects invalid or ambiguous port %j rather than falling back',
  (port) => {
    expect(() => loadApiConfiguration({ API_PORT: port })).toThrow(
      'Invalid API configuration',
    );
  },
);

test.each(['127.0.0.1', '::1', '0.0.0.0'])(
  'API accepts explicit bind address %s',
  (host) => {
    expect(loadApiConfiguration({ API_HOST: host }).host).toBe(host);
  },
);

test.each(['', 'localhost', 'example.com', '192.0.2.1', ' 127.0.0.1'])(
  'API rejects unsupported bind address %j',
  (host) => {
    expect(() => loadApiConfiguration({ API_HOST: host })).toThrow(
      'Invalid API configuration',
    );
  },
);

for (const load of [loadApiConfiguration, loadWorkerConfiguration]) {
  test.each(['', 'production', 'hosted', 'LOCAL', 'fictional-sensitive-value'])(
    'rejects unsupported application mode %j without echoing it',
    (mode) => {
      let failure;
      try {
        load({ APP_MODE: mode });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/^Invalid (API|worker) configuration$/);
      expect(failure.cause).toBeUndefined();
    },
  );
}
