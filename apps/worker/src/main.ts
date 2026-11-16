import 'reflect-metadata';
import { Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Injectable()
class IdleLifetime implements OnApplicationShutdown {
  // Temporary process lifetime only: no polling, jobs, or dependency readiness is claimed.
  private readonly keepAlive = setInterval(() => {}, 60_000);

  onApplicationShutdown(): void {
    clearInterval(this.keepAlive);
  }
}

@Module({ providers: [IdleLifetime] })
class WorkerModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });
  app.enableShutdownHooks();
  console.log(JSON.stringify({ event: 'worker_idle', ready: false }));
}

void main().catch(() => {
  console.error(JSON.stringify({ event: 'worker_start_failed' }));
  process.exitCode = 1;
});
