import { noTelemetry, type Telemetry } from '@lab/telemetry';
import 'reflect-metadata';
import { Controller, Get, HttpException, Inject, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  TicketController,
  TICKET_SERVICE,
  TICKET_TELEMETRY,
} from './ticket-http';
import type { TicketService } from './ticket-access';

export interface ReadinessProbe {
  isReady(): Promise<boolean>;
}
const READINESS = Symbol('readiness');

@Controller('health')
class HealthController {
  constructor(
    @Inject(READINESS) private readonly dependencies: ReadinessProbe,
  ) {}
  @Get('live')
  live(): { status: string } {
    return { status: 'alive' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string }> {
    let ready = false;
    try {
      ready = await this.dependencies.isReady();
    } catch {
      /* Dependency diagnostics stay private. */
    }
    if (!ready) throw new HttpException({ status: 'not_ready' }, 503);
    return { status: 'ready' };
  }
}

@Module({ controllers: [HealthController, TicketController] })
class ApiModule {}

export async function createApi(
  dependencies: ReadinessProbe = { isReady: async () => false },
  tickets?: TicketService,
  telemetry: Telemetry = noTelemetry,
) {
  const app = await NestFactory.create(
    {
      module: ApiModule,
      providers: [
        { provide: READINESS, useValue: dependencies },
        { provide: TICKET_SERVICE, useValue: tickets ?? null },
        { provide: TICKET_TELEMETRY, useValue: telemetry },
        {
          provide: 'telemetry-lifecycle',
          useValue: { onApplicationShutdown: () => telemetry.shutdown() },
        },
      ],
    },
    { logger: false, bodyParser: false },
  );
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}
