const {
  loadApiConfiguration,
  loadWorkerConfiguration,
  loadRelayConfiguration,
  loadConsumerConfiguration,
  loadExecutorConfiguration,
} = require('@lab/configuration');
test('executor has only its independently validated local PostgreSQL endpoint', () => {
  expect(loadExecutorConfiguration({})).toEqual({
    mode: 'local',
    postgres: { host: 'postgres', port: 5432 },
  });
  expect(
    loadExecutorConfiguration({
      EXECUTOR_PG_HOST: '127.0.0.1',
      EXECUTOR_PG_PORT: '5433',
    }).postgres,
  ).toEqual({ host: '127.0.0.1', port: 5433 });
});
test.each([
  { APP_MODE: 'hosted' },
  { EXECUTOR_PG_PORT: '0' },
  { EXECUTOR_PG_PORT: '65536' },
  { EXECUTOR_PG_HOST: 'private-user@host' },
])('executor rejects invalid settings without exposing them', (environment) => {
  expect(() => loadExecutorConfiguration(environment)).toThrow(
    /^Invalid executor configuration$/,
  );
});

test('consumer uses its own validated local endpoints', () => {
  expect(loadConsumerConfiguration({})).toEqual({
    mode: 'local',
    postgres: { host: 'postgres', port: 5432 },
    kafka: { host: 'kafka', port: 9092 },
  });
  expect(
    loadConsumerConfiguration({
      CONSUMER_KAFKA_HOST: '::1',
      CONSUMER_KAFKA_PORT: '9093',
    }).kafka,
  ).toEqual({ host: '::1', port: 9093 });
});
test.each([
  { APP_MODE: 'production' },
  { CONSUMER_PG_PORT: '0' },
  { CONSUMER_KAFKA_PORT: '65536' },
  { CONSUMER_KAFKA_HOST: 'fictional-private-user@broker' },
])('consumer rejects invalid settings with a fixed error', (environment) => {
  expect(() => loadConsumerConfiguration(environment)).toThrow(
    /^Invalid consumer configuration$/,
  );
});

test('relay selects bounded local endpoints independently of the idle worker', () => {
  expect(loadRelayConfiguration({})).toEqual({
    mode: 'local',
    postgres: { host: 'postgres', port: 5432 },
    kafka: { host: 'kafka', port: 9092 },
  });
  expect(
    loadRelayConfiguration({
      RELAY_KAFKA_HOST: '::1',
      RELAY_KAFKA_PORT: '9093',
    }).kafka,
  ).toEqual({ host: '::1', port: 9093 });
});
test.each([
  { APP_MODE: 'production' },
  { RELAY_PG_PORT: '0' },
  { RELAY_KAFKA_PORT: '65536' },
  { RELAY_KAFKA_HOST: 'secret@broker' },
])('relay rejects unsafe settings with a fixed error', (environment) => {
  expect(() => loadRelayConfiguration(environment)).toThrow(
    /^Invalid relay configuration$/,
  );
});

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

test('API dependency mode supplies explicit local endpoints without changing standalone defaults', () => {
  expect(loadApiConfiguration({}).dependencies).toBeUndefined();
  expect(
    loadApiConfiguration({
      API_DEPENDENCIES: 'local',
      API_PG_HOST: '127.0.0.1',
      API_PG_PORT: '5433',
      API_REDIS_HOST: 'redis',
      API_REDIS_PORT: '6380',
    }).dependencies,
  ).toEqual({
    postgres: { host: '127.0.0.1', port: 5433 },
    redis: { host: 'redis', port: 6380 },
  });
});
test.each([
  { API_DEPENDENCIES: 'hosted' },
  { API_PG_PORT: '0' },
  { API_REDIS_PORT: '65536' },
  { API_PG_HOST: 'postgres://fictional-sensitive-value@host' },
  { API_REDIS_HOST: '' },
  { API_PG_HOST: '-invalid' },
  { API_REDIS_HOST: 'invalid..host' },
])(
  'API rejects invalid dependency configuration without exposing values',
  (environment) => {
    expect(() => loadApiConfiguration(environment)).toThrow(
      /^Invalid API configuration$/,
    );
  },
);
