import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './modulo-aplicacao';
import type { AppConfig } from './configuracao';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  return app;
}
