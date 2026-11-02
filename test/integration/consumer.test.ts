import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { RecordPermanentFailure } from '../../src/aplicacao/registrar-falha';
import { startApi, type TestApi } from '../support/api';
import { resetDatabase } from '../support/database';
import { consumerFor, createQueues, drain, peekAll, sendMessage, sqs, type TestQueues } from '../support/fila';
import { checkInvariants } from '../support/invariants';
import { balanceOf, createWallet, txBody } from '../support/wagering';
import type { ConsumeOutcome } from '../../src/fila/consumidor-transacoes';

let api: TestApi;
let queues: TestQueues;

beforeAll(async () => {
  // lock_timeout curto pra simular carteira ocupada (falha transitória) sem esperar 5 s
  api = await startApi((c) => ({ ...c, db: { ...c.db, lockTimeoutMs: 300 } }));
});

beforeEach(async () => {
  await resetDatabase(api.orm);
  queues = await createQueues(2);
});

afterEach(async () => {
  expect(await checkInvariants(api.orm)).toEqual([]);
  await queues.remove();
});

afterAll(async () => {
  await api.close();
});

const sql = (query: string, params: unknown[] = []) => api.orm.em.getConnection().execute(query, params);
const debits = async (walletId: string) =>
  (await sql(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]))[0]!.n;

describe('consumo', () => {
  test('BET pela fila: processa, grava a inbox no mesmo commit e faz ack', async () => {
    const w = await createWallet(api, '100');
    const messageId = await sendMessage(queues, txBody(w, 'BET', '25.00'));

    expect(await drain(consumerFor(api, queues))).toEqual(['ACKED']);
    expect(await balanceOf(api, w.id)).toBe('75.00');
    const inbox = await sql('select consumer_name, message_id from inbox_messages');
    expect(inbox).toEqual([{ consumer_name: 'wager-transactions-consumer', message_id: messageId }]);
    expect(await peekAll(queues.inputUrl, 1, 1500)).toHaveLength(0);
  });

  test('mesma mensagem entregue duas vezes (o broker não deduplicou): um único efeito', async () => {
    const w = await createWallet(api, '100');
    const body = txBody(w, 'BET', '10');
    await sendMessage(queues, body, { messageId: 'msg-1' });
    await sendMessage(queues, body, { messageId: 'msg-1' });

    expect((await drain(consumerFor(api, queues))).sort()).toEqual(['ACKED', 'DUPLICATE']);
    expect(await debits(w.id)).toBe(1);
    expect(await balanceOf(api, w.id)).toBe('90.00');
  });

  test('mensagem nova repetindo uma operação já feita pela API vira replay e entra na inbox', async () => {
    const w = await createWallet(api, '100');
    const body = txBody(w, 'BET', '10');
    await api.post('/wagering/transactions', body, { 'idempotency-key': `provider-a:${body.externalTransactionId}` });
    await sendMessage(queues, body);

    expect(await drain(consumerFor(api, queues))).toEqual(['ACKED']);
    expect(await debits(w.id)).toBe(1);
    expect(await sql('select 1 from inbox_messages')).toHaveLength(1);
  });

  test('rejeição de negócio também é ack (não vai pra DLQ)', async () => {
    const w = await createWallet(api, '1');
    await sendMessage(queues, txBody(w, 'BET', '50'));
    expect(await drain(consumerFor(api, queues))).toEqual(['ACKED']);
    const [tx] = await sql('select status, failure_code from wager_transactions where kind = ?', ['BET']);
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await peekAll(queues.dlqUrl, 1, 1500)).toHaveLength(0);
  });

  test('REFUND antes da BET pela fila: fica pendente e é liberado quando a BET chega', async () => {
    const w = await createWallet(api, '100');
    await sendMessage(queues, txBody(w, 'REFUND', '40', { reference: 'bet-1' }));
    await sendMessage(queues, txBody(w, 'BET', '40', { externalTransactionId: 'bet-1' }));
    expect(await drain(consumerFor(api, queues))).toEqual(['ACKED', 'ACKED']);
    expect(await balanceOf(api, w.id)).toBe('100.00');
    const [refund] = await sql(`select status from wager_transactions where kind = 'REFUND'`);
    expect(refund).toEqual({ status: 'PROCESSED' });
  });
});

describe('falhas', () => {
  test('worker morto depois do commit e antes do ack: a reentrega não duplica o débito', async () => {
    const w = await createWallet(api, '100');
    await sendMessage(queues, txBody(w, 'BET', '30'));

    // cliente SQS de um processo que "morre" logo depois do commit: nem ack nem devolução
    const dying = {
      send: (command: unknown, options?: unknown) =>
        command instanceof DeleteMessageCommand || command instanceof ChangeMessageVisibilityCommand
          ? Promise.reject(new Error('processo morreu'))
          : sqs.send(command as never, options as never),
    } as unknown as SQSClient;
    await expect(consumerFor(api, queues, { client: dying }).pollOnce()).rejects.toThrow('processo morreu');
    expect(await balanceOf(api, w.id)).toBe('70.00');

    // outra instância pega a mensagem quando a visibilidade (2 s) vence
    const other = await startApi();
    try {
      const outcomes: ConsumeOutcome[] = [];
      const consumer = consumerFor(other, queues, { outcomes });
      const deadline = Date.now() + 10_000;
      while (!outcomes.includes('DUPLICATE') && Date.now() < deadline) await consumer.pollOnce();
      expect(outcomes).toEqual(['DUPLICATE']);
    } finally {
      await other.close();
    }
    expect(await debits(w.id)).toBe(1);
    expect(await balanceOf(api, w.id)).toBe('70.00');
  });

  test.each([
    ['JSON inválido', { rawBody: '{nao-e-json' }, 'INVALID_MESSAGE'],
    ['type desconhecido', { rawBody: JSON.stringify({ messageId: 'm', type: 'Outro', occurredAt: 'x', data: {} }) }, 'INVALID_MESSAGE'],
  ])('mensagem malformada (%s) vai direto pra DLQ', async (_, options, code) => {
    await sendMessage(queues, { walletId: 'g' }, options);
    expect(await drain(consumerFor(api, queues))).toEqual(['DEAD_LETTERED']);
    const [dead] = await peekAll(queues.dlqUrl, 1);
    expect(dead!.MessageAttributes?.errorCode?.StringValue).toBe(code);
    expect(dead!.Body).toBe(options.rawBody);
  });

  test('erro permanente de aplicação (carteira inexistente) vai pra DLQ sem retry', async () => {
    await sendMessage(queues, txBody({ id: crypto.randomUUID(), playerId: 'p', currency: 'BRL' }, 'BET', '1'));
    expect(await drain(consumerFor(api, queues))).toEqual(['DEAD_LETTERED']);
    const [dead] = await peekAll(queues.dlqUrl, 1);
    expect(dead!.MessageAttributes?.errorCode?.StringValue).toBe('WALLET_NOT_FOUND');
  });

  test('mesmo messageId com conteúdo diferente: conflito, vai pra DLQ', async () => {
    const w = await createWallet(api, '100');
    await sendMessage(queues, txBody(w, 'BET', '10'), { messageId: 'msg-x' });
    await sendMessage(queues, txBody(w, 'BET', '20'), { messageId: 'msg-x' });
    expect(await drain(consumerFor(api, queues))).toEqual(['ACKED', 'DEAD_LETTERED']);
    const [dead] = await peekAll(queues.dlqUrl, 1);
    expect(dead!.MessageAttributes?.errorCode?.StringValue).toBe('MESSAGE_ID_CONFLICT');
    expect(await balanceOf(api, w.id)).toBe('90.00');
  });

  test('falha transitória (carteira travada): retry com backoff e DLQ depois de maxAttempts', async () => {
    const w = await createWallet(api, '100');
    await sendMessage(queues, txBody(w, 'BET', '10'));

    // outra transação segura o lock da carteira durante o teste inteiro
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locker = api.orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [w.id]);
      await held;
    });
    try {
      const outcomes = await drain(consumerFor(api, queues, { maxAttempts: 3 }));
      expect(outcomes).toEqual(['RETRY', 'RETRY', 'DEAD_LETTERED']);
      const [dead] = await peekAll(queues.dlqUrl, 1);
      expect(dead!.MessageAttributes).toMatchObject({
        errorCode: { StringValue: 'RETRIES_EXHAUSTED:WALLET_BUSY' },
        receiveCount: { StringValue: '3' },
      });
    } finally {
      release();
      await locker;
    }
    expect(await balanceOf(api, w.id)).toBe('100.00');
  });

  test('tentativas esgotadas gravam a transação como FAILED, terminal e auditável', async () => {
    const w = await createWallet(api, '100');
    const body = txBody(w, 'BET', '10');
    const command = {
      idempotencyKey: `provider-a:${body.externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId: body.externalTransactionId as string,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET' as const,
      money: { amount: '10', currency: 'BRL' },
      referenceExternalTransactionId: null,
    };
    const failed = await api.app.get(RecordPermanentFailure).execute(command, 'corr-1');
    expect(failed!.status).toBe('FAILED');

    // reenvio da mesma operação pela API devolve o FAILED gravado (500), sem debitar
    const replay = await api.post('/wagering/transactions', body, { 'idempotency-key': command.idempotencyKey });
    expect(replay.status).toBe(500);
    expect(replay.body).toMatchObject({ status: 'FAILED', failureCode: 'PROCESSING_FAILED', idempotentReplay: true });
    expect(await balanceOf(api, w.id)).toBe('100.00');
  });
});

describe('vários consumidores', () => {
  test('3 instâncias consumindo a mesma fila, com duplicatas: cada operação aplicada uma vez', async () => {
    const others = await Promise.all([startApi(), startApi()]);
    try {
      const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(api, '100')));
      let expectedDebits = 0;
      for (const w of wallets) {
        for (let i = 0; i < 5; i++) {
          const body = txBody(w, 'BET', '3');
          const messageId = `msg-${w.id}-${i}`;
          await sendMessage(queues, body, { messageId });
          await sendMessage(queues, body, { messageId }); // duplicata do produtor
          expectedDebits += 1;
        }
      }

      const consumers = [api, ...others].map((instance) => consumerFor(instance, queues));
      const outcomes = (await Promise.all(consumers.map((c) => drain(c)))).flat();

      expect(outcomes.filter((o) => o === 'ACKED')).toHaveLength(expectedDebits);
      expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(expectedDebits);
      for (const w of wallets) expect(await balanceOf(api, w.id)).toBe('85.00');
    } finally {
      await Promise.all(others.map((o) => o.close()));
    }
  });
});
