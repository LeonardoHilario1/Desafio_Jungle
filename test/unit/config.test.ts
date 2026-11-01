import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/configuracao';

const validEnv = {
  PORT: '3000',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'db',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_OUTBOX_QUEUE_NAME: 'q',
};

describe('loadConfig', () => {
  test('lê um ambiente completo', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3000);
    expect(config.db.port).toBe(5432);
    expect(config.sqs.outboxQueueName).toBe('q');
  });

  test('falha na subida se faltar variável obrigatória', () => {
    const { DB_HOST: _, ...env } = validEnv;
    expect(() => loadConfig(env)).toThrow('DB_HOST');
  });

  test('rejeita porta inválida', () => {
    expect(() => loadConfig({ ...validEnv, DB_PORT: 'abc' })).toThrow('DB_PORT');
    expect(() => loadConfig({ ...validEnv, PORT: '70000' })).toThrow('PORT');
  });
});
