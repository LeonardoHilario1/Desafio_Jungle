import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../src/configuracao';
import { startApi, type TestApi } from '../support/api';
import { resetDatabase } from '../support/database';
import { createQueues, sendMessage, sqs, type TestQueues } from '../support/fila';
import { checkInvariants } from '../support/invariants';
import { balanceOf, createWallet, txBody } from '../support/wagering';

let queues: TestQueues;
let eventsQueueName: string;
let eventsQueueUrl: string;

beforeEach(async () => {
  queues = await createQueues(2);
  eventsQueueName = `events-${crypto.randomUUID()}`;
  eventsQueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: eventsQueueName }))).QueueUrl!;
});

afterEach(async () => {
  await queues.remove();
  await sqs.send(new DeleteQueueCommand({ QueueUrl: eventsQueueUrl }));
});

/** instância com tudo ligado, como em produção: consumidor, publisher e worker de pendências */
const live = (c: AppConfig): AppConfig => ({
  ...c,
  sqs: { ...c.sqs, inputQueueName: queues.inputQueueName, dlqName: queues.dlqName, outboxQueueName: eventsQueueName },
  consumer: { ...c.consumer, enabled: true, waitTimeSeconds: 1 },
  outbox: { publisherEnabled: true, pollIntervalMs: 50 },
  pendingReference: { ...c.pendingReference, workerEnabled: true, pollIntervalMs: 50 },
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('tempo esgotado esperando a condição');
}

test('reinício no meio do processamento: a segunda instância termina e o estado final é consistente', async () => {
  let first: TestApi | undefined = await startApi(live);
  let second: TestApi | undefined;
  try {
    await resetDatabase(first.orm);
    const sql = (q: string, p: unknown[] = []) => first!.orm.em.getConnection().execute(q, p);
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(first!, '100')));

    // por carteira: REFUND antes da BET que ele devolve, 5 BETs, um WIN; cada mensagem
    // publicada duas vezes pelo "provedor"
    let unique = 0;
    for (const w of wallets) {
      const bodies = [
        txBody(w, 'REFUND', '2', { reference: `bet-${w.id}-0` }),
        ...Array.from({ length: 5 }, (_, i) => txBody(w, 'BET', '2', { externalTransactionId: `bet-${w.id}-${i}` })),
        txBody(w, 'WIN', '3'),
      ];
      for (const body of bodies) {
        const messageId = `msg-${body.externalTransactionId}`;
        await sendMessage(queues, body, { messageId });
        await sendMessage(queues, body, { messageId });
        unique += 1;
      }
    }

    // derruba a primeira instância (shutdown gracioso, como no SIGTERM) no meio do caminho
    await waitFor(async () => (await sql('select count(*)::int as n from inbox_messages'))[0]!.n >= 4);
    await first.close();
    first = undefined;

    second = await startApi(live);
    const sql2 = (q: string, p: unknown[] = []) => second!.orm.em.getConnection().execute(q, p);
    await waitFor(async () => (await sql2('select count(*)::int as n from inbox_messages'))[0]!.n === unique);
    await waitFor(async () => (await sql2('select count(*)::int as n from outbox_messages where published_at is null'))[0]!.n === 0);

    // cada carteira: 100 - 5 × 2 (BET) + 2 (REFUND) + 3 (WIN)
    for (const w of wallets) expect(await balanceOf(second, w.id)).toBe('95.00');
    expect(await checkInvariants(second.orm)).toEqual([]);
    expect(await sql2(`select 1 from wager_transactions where status = 'PENDING_REFERENCE'`)).toEqual([]);

    // a fila de entrada terminou vazia e nada foi pra DLQ
    const leftovers = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.inputUrl, WaitTimeSeconds: 1 }));
    expect(leftovers.Messages ?? []).toEqual([]);
    const dead = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.dlqUrl, WaitTimeSeconds: 1 }));
    expect(dead.Messages ?? []).toEqual([]);
  } finally {
    await first?.close();
    await second?.close();
  }
}, 90_000);
