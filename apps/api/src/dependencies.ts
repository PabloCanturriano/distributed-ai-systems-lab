import type { ApiDependencyConfiguration } from '@lab/configuration';
import { createClient } from '@redis/client';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Pool } from 'pg';
import type { ReadinessProbe } from './app';

type DependencyEvent =
  | 'postgres_connection_error'
  | 'redis_connection_error'
  | 'redis_connection_stopped'
  | 'redis_readiness_timeout';

export class ApiDependencies implements ReadinessProbe {
  private readonly postgres: Pool;
  private readonly redis: ReturnType<typeof createClient>;
  private pending: Promise<boolean> | undefined;
  private closed = false;

  private constructor(
    configuration: ApiDependencyConfiguration,
    password: string,
  ) {
    this.postgres = new Pool({
      host: configuration.postgres.host,
      port: configuration.postgres.port,
      database: 'lab',
      user: 'lab_api_login',
      password,
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 500,
      query_timeout: 750,
      statement_timeout: 500,
      idleTimeoutMillis: 1000,
      application_name: 'lab-api',
    });
    this.postgres.on('error', () => this.report('postgres_connection_error'));
    this.redis = createClient({
      socket: {
        host: configuration.redis.host,
        port: configuration.redis.port,
        connectTimeout: 1000,
        reconnectStrategy: (retries) => Math.min(200 * (retries + 1), 2000),
      },
      disableOfflineQueue: true,
      commandsQueueMaxLength: 8,
      commandOptions: { timeout: 1000 },
    });
    this.redis.on('error', () => this.report('redis_connection_error'));
    this.connectRedis();
  }

  static async create(
    configuration: ApiDependencyConfiguration,
  ): Promise<ApiDependencies> {
    const file = await open(
      '/run/lab/api/password',
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size !== 43
      )
        throw new Error('Invalid API database credential file');
      const password = await file.readFile('utf8');
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(password) ||
        Buffer.from(password, 'base64url').toString('base64url') !== password
      )
        throw new Error('Invalid API database credential file');
      return new ApiDependencies(configuration, password);
    } finally {
      await file.close();
    }
  }

  private report(event: DependencyEvent): void {
    if (!this.closed) console.warn(JSON.stringify({ event }));
  }

  private connectRedis(): void {
    if (!this.closed)
      void this.redis
        .connect()
        .catch(() => this.report('redis_connection_stopped'));
  }

  private async redisPing(): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Redis readiness deadline exceeded'));
        this.report('redis_readiness_timeout');
        // The SDK queue timeout stops at send time. Close an unresponsive in-flight socket
        // so stale replies cannot build up, then reconnect without retrying this command.
        if (!this.closed && this.redis.isOpen) {
          this.redis.destroy();
          this.connectRedis();
        }
      }, 1000);
    });
    try {
      return await Promise.race([this.redis.ping(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async postgresReady(): Promise<boolean> {
    const client = await this.postgres.connect();
    let failed = false;
    try {
      await client.query('SET ROLE lab_api');
      const result = await client.query<{
        contract_version: number;
        identities_ready: boolean;
      }>('SELECT contract_version,identities_ready FROM lab.api_readiness');
      return (
        result.rows.length === 1 &&
        result.rows[0]?.contract_version === 1 &&
        result.rows[0]?.identities_ready === true
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      client.release(failed);
    }
  }

  isReady(): Promise<boolean> {
    if (this.closed || !this.redis.isReady) return Promise.resolve(false);
    this.pending ??= Promise.allSettled([
      this.postgresReady(),
      this.redisPing(),
    ])
      .then(
        ([postgres, redis]) =>
          !this.closed &&
          postgres.status === 'fulfilled' &&
          postgres.value === true &&
          redis.status === 'fulfilled' &&
          redis.value === 'PONG',
      )
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    if (this.redis.isOpen) this.redis.destroy();
    await this.postgres.end();
  }
}
