import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './api/error.filter';
import { OpenWallet } from './application/open-wallet';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { WageringQueries } from './application/wagering-queries';
import { WAGERING_UNIT_OF_WORK } from './application/wagering-store';
import { APP_CONFIG, type AppConfig } from './config';
import { HealthController } from './health/health.controller';
import { ReadinessService } from './health/readiness.service';
import { ormOptions } from './mikro-orm.config';
import { OutboxPublisher } from './outbox/outbox-publisher';
import { OutboxPublisherWorker } from './outbox/outbox-publisher.worker';
import { MikroOrmWageringUnitOfWork } from './persistence/mikro-orm-wagering-store';
import { WageringController } from './wagering/wagering.controller';
import { WalletsController } from './wallets/wallets.controller';

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
        // Porta de persistência dos casos de uso, implementada com MikroORM.
        {
          provide: WAGERING_UNIT_OF_WORK,
          useFactory: (orm: MikroORM) => new MikroOrmWageringUnitOfWork(orm),
          inject: [MikroORM],
        },
        ReadinessService,
        OpenWallet,
        ProcessWagerTransaction,
        WageringQueries,
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
