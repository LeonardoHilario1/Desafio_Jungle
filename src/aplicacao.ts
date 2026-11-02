import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './modulo-aplicacao';
import type { AppConfig } from './configuracao';
import { correlationMiddleware } from './observabilidade/middleware-correlacao';
import { JsonLogger } from './observabilidade/logger-json';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { logger: new JsonLogger(config.logLevel) });
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  return app;
}
