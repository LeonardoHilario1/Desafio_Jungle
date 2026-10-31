import type { AppConfig } from '../../src/config';

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
    },
    sqs: {
      region: 'us-east-1',
      endpoint: env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      outboxQueueName: 'wagering-events',
    },
  };
}
