import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './api/error.filter';
import { APP_CONFIG, type AppConfig } from './config';
import { HealthController } from './health/health.controller';
import { ReadinessService } from './health/readiness.service';
import { ormOptions } from './mikro-orm.config';
import { OutboxPublisher } from './outbox/outbox-publisher';
import { OutboxPublisherWorker } from './outbox/outbox-publisher.worker';
import { WageringController } from './wagering/wagering.controller';
import { WageringService } from './wagering/wagering.service';
import { WalletsController } from './wallets/wallets.controller';
import { WalletsService } from './wallets/wallets.service';

// Módulo dinâmico: a configuração entra por parâmetro, e os testes montam a
// aplicação apontando para o banco de testes sem mexer em process.env.
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormOptions(config.db))],
      controllers: [HealthController, WalletsController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: SQSClient,
          useFactory: () =>
            new SQSClient({
              region: config.sqs.region,
              endpoint: config.sqs.endpoint,
              credentials: {
                accessKeyId: config.sqs.accessKeyId,
                secretAccessKey: config.sqs.secretAccessKey,
              },
            }),
        },
        ReadinessService,
        WalletsService,
        WageringService,
        {
          provide: OutboxPublisher,
          useFactory: (orm: MikroORM, sqs: SQSClient) => new OutboxPublisher(orm, sqs, config.sqs.outboxQueueName),
          inject: [MikroORM, SQSClient],
        },
        OutboxPublisherWorker,
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
