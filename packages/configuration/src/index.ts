import { z } from 'zod';
import { isIP } from 'node:net';

const workerEnvironment = z.object({
  APP_MODE: z.literal('local').default('local'),
});

const dependencyHost = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (host) =>
      isIP(host) !== 0 ||
      host
        .split('.')
        .every((label) =>
          /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
        ),
  );
const dependencyPort = (value: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]{0,4}$/)
    .transform(Number)
    .pipe(z.number().int().max(65535))
    .default(value);

export interface ApiDependencyConfiguration {
  postgres: { host: string; port: number };
  redis: { host: string; port: number };
}

const apiEnvironment = workerEnvironment.extend({
  API_DEPENDENCIES: z.enum(['disabled', 'local']).default('disabled'),
  API_PG_HOST: dependencyHost.default('postgres'),
  API_PG_PORT: dependencyPort(5432),
  API_REDIS_HOST: dependencyHost.default('redis'),
  API_REDIS_PORT: dependencyPort(6379),
  API_HOST: z.enum(['127.0.0.1', '::1', '0.0.0.0']).default('127.0.0.1'),
  API_PORT: z
    .string()
    .regex(/^[1-9][0-9]{0,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default(3000),
});

type Environment = Readonly<Record<string, string | undefined>>;

export function loadApiConfiguration(environment: Environment) {
  const result = apiEnvironment.safeParse(environment);
  // Keep the detailed Zod error private: it can contain raw environment values.
  if (!result.success) throw new Error('Invalid API configuration');
  const dependencies: ApiDependencyConfiguration | undefined =
    result.data.API_DEPENDENCIES === 'local'
      ? {
          postgres: {
            host: result.data.API_PG_HOST,
            port: result.data.API_PG_PORT,
          },
          redis: {
            host: result.data.API_REDIS_HOST,
            port: result.data.API_REDIS_PORT,
          },
        }
      : undefined;
  return Object.freeze({
    ...(dependencies ? { dependencies } : {}),
    mode: result.data.APP_MODE,
    host: result.data.API_HOST,
    port: result.data.API_PORT,
  });
}

export function loadWorkerConfiguration(environment: Environment) {
  const result = workerEnvironment.safeParse(environment);
  if (!result.success) throw new Error('Invalid worker configuration');
  return Object.freeze({ mode: result.data.APP_MODE });
}
