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
import { REFERENCE_RETRY_POLICY } from './aplicacao/liquidacao';
import { RecordPermanentFailure } from './aplicacao/registrar-falha';
import { RetryPendingReferences } from './aplicacao/reprocessar-pendencias';
import { WagerTransactionConsumer } from './fila/consumidor-transacoes';
import { ConsumerWorker } from './fila/worker-consumidor';
import { PendingReferenceWorker } from './pendencias/worker-pendencias';
import { APP_CONFIG, type AppConfig } from './configuracao';
import { HealthController } from './saude/controlador-saude';
import { ReadinessService } from './saude/verificacao-prontidao';
import { ormOptions } from './configuracao-orm';
import { OutboxPublisher } from './outbox/publicador-outbox';
import { OutboxPublisherWorker } from './outbox/worker-publicador-outbox';
import { MikroOrmWageringUnitOfWork } from './persistencia/repositorio-apostas-mikro-orm';
import { WageringController } from './apostas/controlador-apostas';
import { WalletsController } from './carteiras/controlador-carteiras';

// módulo dinâmico: a configuração entra por parâmetro, assim nos testes eu monto a
// aplicação apontando pro banco de testes sem mexer no process.env
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
        // porta de persistência dos casos de uso, implementada com MikroORM
        {
          provide: WAGERING_UNIT_OF_WORK,
          useFactory: (orm: MikroORM) => new MikroOrmWageringUnitOfWork(orm, config.db.lockTimeoutMs),
          inject: [MikroORM],
        },
        {
          provide: REFERENCE_RETRY_POLICY,
          useValue: {
            baseDelayMs: config.pendingReference.baseDelayMs,
            maxDelayMs: config.pendingReference.maxDelayMs,
            maxAttempts: config.pendingReference.maxAttempts,
          },
        },
        ReadinessService,
        OpenWallet,
        ProcessWagerTransaction,
        WageringQueries,
        RecordPermanentFailure,
        RetryPendingReferences,
        {
          provide: WagerTransactionConsumer,
          useFactory: (process: ProcessWagerTransaction, failure: RecordPermanentFailure, sqs: SQSClient) =>
            new WagerTransactionConsumer(process, failure, sqs, config.sqs, config.consumer),
          inject: [ProcessWagerTransaction, RecordPermanentFailure, SQSClient],
        },
        ConsumerWorker,
        PendingReferenceWorker,
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
