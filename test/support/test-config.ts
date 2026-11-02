import type { AppConfig } from '../../src/configuracao';

// Testes de integração usam o PostgreSQL e o LocalStack reais do docker-compose,
// com um banco separado (wagering_test). Nada de mock do banco.
export function testConfig(): AppConfig {
  const env = process.env;
  return {
    port: 0,
    db: {
      host: env.TEST_DB_HOST ?? 'localhost',
      port: Number(env.TEST_DB_PORT ?? 5432),
      user: env.TEST_DB_USER ?? 'wagering',
      password: env.TEST_DB_PASSWORD ?? 'wagering',
      name: env.TEST_DB_NAME ?? 'wagering_test',
      lockTimeoutMs: 5000,
    },
    sqs: {
      region: 'us-east-1',
      endpoint: env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      outboxQueueName: 'wagering-events',
      inputQueueName: 'wager-transactions.fifo',
      dlqName: 'wager-transactions-dlq.fifo',
    },
    // Os testes chamam o publisher diretamente, sem o loop em segundo plano.
    outbox: { publisherEnabled: false, pollIntervalMs: 50 },
    // consumidor e worker de pendências também ficam desligados: os testes chamam direto
    consumer: {
      enabled: false,
      name: 'wager-transactions-consumer',
      maxAttempts: 3,
      retryBaseSeconds: 0,
      waitTimeSeconds: 0,
      shutdownTimeoutMs: 5000,
    },
    pendingReference: { workerEnabled: false, pollIntervalMs: 50, baseDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 10 },
  };
}
