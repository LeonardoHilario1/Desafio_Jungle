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
import { Logger } from '@nestjs/common';
import { MetricsController } from './observabilidade/controlador-metricas';
import { Metrics } from './observabilidade/metricas';
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
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        // uma instância de métricas por aplicação
        { provide: Metrics, useValue: new Metrics() },
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
          useFactory: (process: ProcessWagerTransaction, failure: RecordPermanentFailure, sqs: SQSClient, metrics: Metrics) =>
            new WagerTransactionConsumer(process, failure, sqs, config.sqs, config.consumer, consumerObserver(metrics)),
          inject: [ProcessWagerTransaction, RecordPermanentFailure, SQSClient, Metrics],
        },
        ConsumerWorker,
        PendingReferenceWorker,
        {
          provide: OutboxPublisher,
          useFactory: (orm: MikroORM, sqs: SQSClient, metrics: Metrics) =>
            new OutboxPublisher(orm, sqs, config.sqs.outboxQueueName, metrics),
          inject: [MikroORM, SQSClient, Metrics],
        },
        OutboxPublisherWorker,
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}

/** conta e loga o resultado de cada mensagem da fila */
function consumerObserver(metrics: Metrics) {
  const logger = new Logger('WagerTransactionConsumer');
  return {
    onOutcome(outcome: string, info: { errorCode?: string }) {
      metrics.inc('wagering_consumer_messages_total', { outcome: outcome.toLowerCase() });
      if (outcome === 'RETRY') {
        metrics.inc('wagering_consumer_retries_total');
        logger.warn({ msg: 'falha transitória, mensagem volta pra fila com backoff', errorCode: info.errorCode });
      } else if (outcome === 'DEAD_LETTERED') {
        // RETRIES_EXHAUSTED:WALLET_BUSY vira o motivo RETRIES_EXHAUSTED
        metrics.inc('wagering_dlq_messages_total', { reason: (info.errorCode ?? 'UNKNOWN').split(':')[0]! });
        logger.error({ msg: 'mensagem mandada pra DLQ', errorCode: info.errorCode });
      }
    },
  };
}
