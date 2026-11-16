import { z } from 'zod';

const workerEnvironment = z.object({
  APP_MODE: z.literal('local').default('local'),
});

const apiEnvironment = workerEnvironment.extend({
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
  return Object.freeze({
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
