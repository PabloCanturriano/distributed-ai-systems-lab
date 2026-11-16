import 'reflect-metadata';
import { Controller, Get, HttpCode, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Controller('health')
class HealthController {
  @Get('live')
  live(): { status: string } {
    return { status: 'alive' };
  }

  @Get('ready')
  @HttpCode(503)
  ready(): { status: string } {
    // Database/bootstrap checks arrive in the next slice. Never advertise readiness early.
    return { status: 'not_ready' };
  }
}

@Module({ controllers: [HealthController] })
class ApiModule {}

export async function createApi() {
  const app = await NestFactory.create(ApiModule, { logger: false });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}
