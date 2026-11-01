import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './api/filtro-erros';
import { OpenWallet } from './aplicacao/abrir-carteira';
import { ProcessWagerTransaction } from './aplicacao/processar-transacao-aposta';
import { WageringQueries } from './aplicacao/consultas-apostas';
import { WAGERING_UNIT_OF_WORK } from './aplicacao/repositorio-apostas';
import { APP_CONFIG, type AppConfig } from './configuracao';
import { HealthController } from './saude/controlador-saude';
import { ReadinessService } from './saude/verificacao-prontidao';
import { ormOptions } from './configuracao-orm';
import { OutboxPublisher } from './outbox/publicador-outbox';
import { OutboxPublisherWorker } from './outbox/worker-publicador-outbox';
import { MikroOrmWageringUnitOfWork } from './persistencia/repositorio-apostas-mikro-orm';
import { WageringController } from './apostas/controlador-apostas';
import { WalletsController } from './carteiras/controlador-carteiras';

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
