import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { createApp } from '../../src/app';
import { OutboxPublisher } from '../../src/outbox/outbox-publisher';
import { startApi, type TestApi } from '../support/api';
import { expectSqlState, resetDatabase } from '../support/database';
import { testConfig } from '../support/test-config';

const config = testConfig();
const sqs = new SQSClient({
  region: config.sqs.region,
  endpoint: config.sqs.endpoint,
  credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
});

let api: TestApi;
let queueName: string;
let queueUrl: string;
let publisher: OutboxPublisher;

beforeAll(async () => {
  api = await startApi();
});

// Fila própria por teste, para não misturar mensagens entre testes.
beforeEach(async () => {
  await resetDatabase(api.orm);
  queueName = `outbox-test-${crypto.randomUUID()}`;
  queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName }))).QueueUrl!;
  publisher = new OutboxPublisher(api.orm, sqs, queueName);
});

afterEach(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
});

afterAll(async () => {
  await api.close();
});

const sql = (query: string, params: unknown[] = []) => api.orm.em.getConnection().execute(query, params);

async function wallet(initialBalance = '100'): Promise<string> {
  const res = await api.post('/wallets', { playerId: `p-${crypto.randomUUID()}`, currency: 'BRL', initialBalance });
  return res.body.id;
}

function submit(key: string, body: Record<string, unknown>) {
  return api.post('/wagering/transactions', body, { 'idempotency-key': key });
}

const bet = (walletId: string, amount: string) => ({ walletId, type: 'BET', amount, currency: 'BRL' });

async function outboxRows() {
  return sql(
    `select event_type, aggregate_id, payload, published_at, attempts, last_error,
            next_attempt_at > now() as delayed
       from outbox_events order by created_at`,
  );
}

async function receiveAll(expected: number, timeoutMs = 10_000): Promise<Message[]> {
  const messages: Message[] = [];
  const deadline = Date.now() + timeoutMs;
  while (messages.length < expected && Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    messages.push(...(res.Messages ?? []));
  }
  return messages;
}

describe('gravação na mesma transação', () => {
  test('cada transação gravada gera exatamente um evento, com valores em string', async () => {
    const w = await wallet('100');
    const processed = await submit('bet-1', bet(w, '30'));
    await submit('bet-2', bet(w, '500'));
    await submit('win-1', { walletId: w, type: 'WIN', amount: '5', currency: 'BRL', referenceKey: 'nao-chegou' });

    const rows = await outboxRows();
    expect(rows.map((r) => r.event_type)).toEqual([
      'wager.transaction.processed',
      'wager.transaction.rejected',
      'wager.transaction.pending_reference',
    ]);
    expect(rows[0]!.aggregate_id).toBe(processed.body.id);
    expect(rows[0]!.payload).toMatchObject({
      transactionId: processed.body.id,
      idempotencyKey: 'bet-1',
      type: 'BET',
      amount: '30.00',
      currency: 'BRL',
      status: 'PROCESSED',
      walletBalance: '70.00',
      walletVersion: 3,
    });
    expect(rows[1]!.payload).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', walletBalance: '70.00' });
    expect(rows.every((r) => r.published_at === null)).toBe(true);
  });

  test('replay, conflito e erros não geram evento', async () => {
    const w = await wallet('100');
    await submit('bet-1', bet(w, '30'));
    await submit('bet-1', bet(w, '30'));
    await submit('bet-1', bet(w, '31'));
    await submit('bet-x', bet(crypto.randomUUID(), '1'));
    expect(await outboxRows()).toHaveLength(1);
  });
});

describe('publisher', () => {
  test('publica no SQS e marca como publicado', async () => {
    const w = await wallet('100');
    const res = await submit('bet-1', bet(w, '30'));

    expect(await publisher.publishBatch()).toBe(1);
    expect(await publisher.publishBatch()).toBe(0);

    const [message] = await receiveAll(1);
    const [row] = await outboxRows();
    expect(row!.published_at).not.toBeNull();
    expect(JSON.parse(message!.Body!)).toMatchObject({ transactionId: res.body.id, amount: '30.00', status: 'PROCESSED' });
    expect(message!.MessageAttributes?.eventType?.StringValue).toBe('wager.transaction.processed');
    expect(message!.MessageAttributes?.eventId?.StringValue).toBe(JSON.parse(message!.Body!).eventId);
  });

  test('não publica evento de transação ainda não commitada', async () => {
    const w = await wallet('100');
    await api.orm.em.fork().transactional(async (em) => {
      const txId = crypto.randomUUID();
      await em.execute(
        `insert into wager_transactions (id, idempotency_key, payload_hash, wallet_id, type, currency, amount, status)
         values (?, 'uncommitted', repeat('a', 64), ?, 'BET', 'BRL', 1, 'PENDING')`,
        [txId, w],
      );
      await em.execute(
        `insert into outbox_events (id, event_type, aggregate_id, payload) values (gen_random_uuid(), 'x', ?, '{}')`,
        [txId],
      );
      // Outra conexão, outra transação: a linha ainda não existe para o publisher.
      expect(await publisher.publishBatch()).toBe(0);
    });
    expect(await publisher.publishBatch()).toBe(1);
  });

  test('vários publishers em paralelo publicam cada evento exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wallet('100')));
    for (const [i, w] of wallets.entries()) {
      for (let j = 0; j < 5; j++) await submit(`bet-${i}-${j}`, bet(w, '1'));
    }

    const publishers = Array.from({ length: 4 }, () => new OutboxPublisher(api.orm, sqs, queueName));
    const counts = await Promise.all(
      publishers.map(async (p) => {
        let total = 0;
        for (let n = await p.publishBatch(); n > 0; n = await p.publishBatch()) total += n;
        return total;
      }),
    );

    expect(counts.reduce((a, b) => a + b, 0)).toBe(25);
    const messages = await receiveAll(25);
    const eventIds = messages.map((m) => m.MessageAttributes?.eventId?.StringValue);
    expect(new Set(eventIds).size).toBe(25);
    expect(messages).toHaveLength(25);
    expect((await outboxRows()).every((r) => r.published_at !== null)).toBe(true);
  });

  test('falha no SQS mantém o evento pendente e agenda nova tentativa com backoff', async () => {
    const w = await wallet('100');
    await submit('bet-1', bet(w, '30'));

    const broken = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    expect(await new OutboxPublisher(api.orm, broken, queueName).publishBatch()).toBe(0);

    const [row] = await outboxRows();
    expect(row).toMatchObject({ published_at: null, attempts: 1, delayed: true });
    expect(row!.last_error).toBeTruthy();

    // Dentro do backoff, nem um publisher saudável pega o evento.
    expect(await publisher.publishBatch()).toBe(0);
    await sql('update outbox_events set next_attempt_at = now()');
    expect(await publisher.publishBatch()).toBe(1);
    expect(await receiveAll(1)).toHaveLength(1);
  });
});

describe('imutabilidade do outbox', () => {
  test('payload não muda, evento publicado não volta a pendente, nada é excluído', async () => {
    const w = await wallet('100');
    await submit('bet-1', bet(w, '30'));
    await expectSqlState(sql(`update outbox_events set payload = '{}'`), 'P0001');
    await expectSqlState(sql('delete from outbox_events'), 'P0001');

    await publisher.publishBatch();
    await expectSqlState(sql('update outbox_events set published_at = null'), 'P0001');
  });
});

describe('worker', () => {
  test('com o publisher ligado, eventos são publicados sem chamada manual', async () => {
    const app = await createApp({
      ...config,
      sqs: { ...config.sqs, outboxQueueName: queueName },
      outbox: { publisherEnabled: true, pollIntervalMs: 50 },
    });
    await app.init();
    try {
      const w = await wallet('100');
      await submit('bet-1', bet(w, '30'));
      expect(await receiveAll(1)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
