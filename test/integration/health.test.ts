import { afterEach, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/aplicacao';
import type { AppConfig } from '../../src/configuracao';
import { testConfig } from '../support/test-config';

let app: INestApplication | undefined;

async function start(config: AppConfig): Promise<string> {
  app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  return (await app.getUrl()).replace('[::1]', '127.0.0.1');
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health/live', () => {
  test('responde 200 sem consultar dependências', async () => {
    const url = await start(testConfig());
    const res = await fetch(`${url}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  test('responde 200 quando PostgreSQL e SQS estão acessíveis', async () => {
    const url = await start(testConfig());
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ready: true,
      checks: { database: { status: 'up' }, queue: { status: 'up' } },
    });
  });

  test('responde 503 quando a fila não existe', async () => {
    const config = testConfig();
    const url = await start({ ...config, sqs: { ...config.sqs, outboxQueueName: 'fila-inexistente' } });
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; checks: { database: { status: string }; queue: { status: string } } };
    expect(body.ready).toBe(false);
    expect(body.checks.database.status).toBe('up');
    expect(body.checks.queue.status).toBe('down');
  });

  test('responde 503 quando o banco está inacessível', async () => {
    const config = testConfig();
    // Porta onde não há PostgreSQL escutando.
    const url = await start({ ...config, db: { ...config.db, port: 1 } });
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: { database: { status: string }; queue: { status: string } } };
    expect(body.checks.database.status).toBe('down');
    expect(body.checks.queue.status).toBe('up');
  });
});
