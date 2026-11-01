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
import { createWallet, submit as submitTx, txBody, type TestWallet } from '../support/wagering';

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

const wallet = (initialBalance = '100'): Promise<TestWallet> => createWallet(api, initialBalance);
const submit = (body: Record<string, unknown>) => submitTx(api, body);
const bet = (w: TestWallet, amount: string) => txBody(w, 'BET', amount);
const published = async (p: OutboxPublisher = publisher) => (await p.publishBatch()).published;

async function outboxRows() {
  return sql(
    `select event_type, aggregate_id, payload, published_at, attempts, last_error,
            next_attempt_at > now() as delayed
       from outbox_messages order by created_at, event_type`,
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
  test('cada resultado gera os seus eventos, com envelope versionado e valores em string', async () => {
    const w = await wallet('100');
    const before = (await outboxRows()).length; // OPENING: Processed + BalanceChanged
    const processed = await submit(bet(w, '30'));
    await submit(bet(w, '500'));
    await submit(txBody(w, 'REFUND', '5', { reference: 'nao-chegou' }));
    await submit(txBody(w, 'LOSS', '0'));

    const rows = (await outboxRows()).slice(before);
    expect(rows.map((r) => r.event_type).sort()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WalletBalanceChanged',
    ]);
    const changed = rows.find((r) => r.event_type === 'WalletBalanceChanged')!;
    expect(changed.aggregate_id).toBe(w.id);
    expect(changed.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: w.id,
      correlationId: expect.any(String),
      data: {
        walletId: w.id,
        transactionId: processed.body.transactionId,
        direction: 'DEBIT',
        money: { amount: '30.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    const rejected = rows.find((r) => r.event_type === 'WagerTransactionRejected')!;
    expect(rejected.payload.data).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '70.00' } });
    // LOSS é processada mas não muda saldo: só um WalletBalanceChanged (o da BET).
    expect(rows.every((r) => r.published_at === null)).toBe(true);
  });

  test('replay, conflito e erros não geram evento', async () => {
    const w = await wallet('100');
    const before = (await outboxRows()).length;
    const body = bet(w, '30');
    await submit(body);
    await submit(body);
    await submit({ ...body, money: { amount: '31', currency: 'BRL' } });
    await submit(bet({ ...w, id: crypto.randomUUID() }, '1'));
    expect((await outboxRows()).length - before).toBe(2);
  });
});

describe('publisher', () => {
  test('publica o envelope no SQS e marca como publicado', async () => {
    const w = await wallet('0');
    const res = await submit(txBody(w, 'WIN', '30'));

    expect(await published()).toBe(2);
    expect(await published()).toBe(0);

    const messages = await receiveAll(2);
    const processed = messages.find((m) => m.MessageAttributes?.eventType?.StringValue === 'WagerTransactionProcessed')!;
    const body = JSON.parse(processed.Body!);
    expect(body).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      version: 1,
      data: { transactionId: res.body.transactionId, money: { amount: '30.00', currency: 'BRL' }, kind: 'WIN' },
    });
    expect(processed.MessageAttributes?.eventId?.StringValue).toBe(body.eventId);
    expect((await outboxRows()).every((r) => r.published_at !== null)).toBe(true);
  });

  test('não publica mensagem de transação ainda não commitada', async () => {
    const w = await wallet('0');
    await api.orm.em.fork().transactional(async (em) => {
      const id = crypto.randomUUID();
      await em.execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         values (?, ?, 'X', jsonb_build_object('eventId', ?::text, 'eventType', 'X'), now(), now())`,
        [id, w.id, id],
      );
      // Outra conexão, outra transação: a linha ainda não existe para o publisher.
      expect(await published()).toBe(0);
    });
    expect(await published()).toBe(1);
  });

  test('vários publishers em paralelo publicam cada mensagem exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wallet('0')));
    for (const w of wallets) {
      for (let j = 0; j < 5; j++) await submit(txBody(w, 'LOSS', '0'));
    }

    const publishers = Array.from({ length: 4 }, () => new OutboxPublisher(api.orm, sqs, queueName));
    const counts = await Promise.all(
      publishers.map(async (p) => {
        let total = 0;
        for (let n = await published(p); n > 0; n = await published(p)) total += n;
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

  test('falha no SQS mantém a mensagem pendente e agenda nova tentativa com backoff', async () => {
    const w = await wallet('0');
    await submit(txBody(w, 'LOSS', '0'));

    const broken = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    expect(await new OutboxPublisher(api.orm, broken, queueName).publishBatch()).toEqual({ published: 0, failed: 1 });

    const [row] = await outboxRows();
    expect(row).toMatchObject({ published_at: null, attempts: 1, delayed: true });
    expect(row!.last_error).toBeTruthy();

    // Dentro do backoff, nem um publisher saudável pega a mensagem.
    expect(await published()).toBe(0);
    await sql('update outbox_messages set next_attempt_at = now()');
    expect(await published()).toBe(1);
    expect(await receiveAll(1)).toHaveLength(1);
  });

  test('o processo morre depois do commit e antes de publicar: outra instância publica', async () => {
    // A "instância que morreu" gravou e commitou, mas nunca publicou. Outra instância,
    // com outro pool de conexões, assume o trabalho.
    const w = await wallet('0');
    await submit(txBody(w, 'LOSS', '0'));
    const other = await startApi();
    try {
      expect(await new OutboxPublisher(other.orm, sqs, queueName).publishBatch()).toEqual({ published: 1, failed: 0 });
    } finally {
      await other.close();
    }
    expect(await receiveAll(1)).toHaveLength(1);
  });
});

describe('imutabilidade da outbox', () => {
  test('payload não muda, mensagem publicada não volta a pendente, nada é excluído', async () => {
    const w = await wallet('0');
    await submit(txBody(w, 'LOSS', '0'));
    await expectSqlState(sql(`update outbox_messages set payload = '{}'`), 'P0001');
    await expectSqlState(sql('delete from outbox_messages'), 'P0001');

    await publisher.publishBatch();
    await expectSqlState(sql('update outbox_messages set published_at = null, next_attempt_at = now()'), 'P0001');
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
      const w = await wallet('0');
      await submit(txBody(w, 'LOSS', '0'));
      expect(await receiveAll(1)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
