import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RetryPendingReferences } from '../../src/aplicacao/reprocessar-pendencias';
import { startApi, type TestApi } from '../support/api';
import { resetDatabase } from '../support/database';
import { checkInvariants } from '../support/invariants';
import { balanceOf, createWallet, submit, txBody } from '../support/wagering';

let api: TestApi;

beforeAll(async () => {
  // política curta pra não esperar minutos: 3 tentativas
  api = await startApi((c) => ({ ...c, pendingReference: { ...c.pendingReference, maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10 } }));
});

beforeEach(async () => {
  await resetDatabase(api.orm);
});

afterEach(async () => {
  expect(await checkInvariants(api.orm)).toEqual([]);
});

afterAll(async () => {
  await api.close();
});

const sql = (query: string, params: unknown[] = []) => api.orm.em.getConnection().execute(query, params);
const worker = () => api.app.get(RetryPendingReferences);
const later = (ms = 60_000) => new Date(Date.now() + ms);

async function statusOf(transactionId: string) {
  return (await api.get(`/wagering/transactions/${transactionId}`)).body;
}

describe('liberação imediata quando a referência chega', () => {
  test('REFUND antes da BET: 202, e processado no mesmo commit da BET', async () => {
    const w = await createWallet(api, '100');
    const refund = await submit(api, txBody(w, 'REFUND', '40', { reference: 'bet-1' }));
    expect(refund.status).toBe(202);

    await submit(api, txBody(w, 'BET', '40', { externalTransactionId: 'bet-1' }));
    const after = await statusOf(refund.body.transactionId);
    expect(after).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect(await balanceOf(api, w.id)).toBe('100.00');

    const events = await sql(
      `select event_type from outbox_messages where payload -> 'data' ->> 'transactionId' = ? order by event_type`,
      [refund.body.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('replay de uma pendência já liberada devolve o estado atual', async () => {
    const w = await createWallet(api, '100');
    const body = txBody(w, 'REFUND', '40', { reference: 'bet-1' });
    await submit(api, body);
    await submit(api, txBody(w, 'BET', '40', { externalTransactionId: 'bet-1' }));
    const replay = await submit(api, body);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
  });

  test('cadeia fora de ordem: ROLLBACK do REFUND, REFUND da BET, BET', async () => {
    const w = await createWallet(api, '100');
    const rollback = await submit(api, txBody(w, 'ROLLBACK', '10', { reference: 'refund-1' }));
    const refund = await submit(api, txBody(w, 'REFUND', '10', { externalTransactionId: 'refund-1', reference: 'bet-1' }));
    expect([rollback.status, refund.status]).toEqual([202, 202]);

    await submit(api, txBody(w, 'BET', '10', { externalTransactionId: 'bet-1' }));
    expect((await statusOf(refund.body.transactionId)).status).toBe('PROCESSED');
    expect((await statusOf(rollback.body.transactionId)).status).toBe('PROCESSED');
    // 100 - 10 (BET) + 10 (REFUND) - 10 (ROLLBACK do REFUND)
    expect(await balanceOf(api, w.id)).toBe('90.00');
  });

  test('referência que termina REJECTED libera a pendência como REJECTED', async () => {
    const w = await createWallet(api, '5');
    const refund = await submit(api, txBody(w, 'REFUND', '40', { reference: 'bet-1' }));
    await submit(api, txBody(w, 'BET', '40', { externalTransactionId: 'bet-1' }));
    expect(await statusOf(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_PROCESSED',
    });
  });
});

describe('worker de pendências', () => {
  test('referência que nunca chega: reagenda com backoff e vira REFERENCE_NOT_FOUND no limite', async () => {
    const w = await createWallet(api, '100');
    const refund = await submit(api, txBody(w, 'REFUND', '40', { reference: 'nunca-vem' }));

    // ainda não venceu: nada a fazer
    expect((await worker().runOnce(new Date())).checked).toBe(0);

    expect(await worker().runOnce(later())).toMatchObject({ checked: 1, rescheduled: 1 });
    expect(await worker().runOnce(later(120_000))).toMatchObject({ checked: 1, rescheduled: 1 });
    expect(await worker().runOnce(later(180_000))).toMatchObject({ checked: 1, rejected: 1 });

    expect(await statusOf(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      balance: { amount: '100.00' },
    });
    const events = await sql(
      `select event_type from outbox_messages where payload -> 'data' ->> 'transactionId' = ? order by event_type`,
      [refund.body.transactionId],
    );
    // um PendingReference no começo e um Rejected no fim; reagendar não gera evento
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });

  test('referência que caiu em outra carteira: o worker resolve (REFERENCE_MISMATCH)', async () => {
    const a = await createWallet(api, '100');
    const b = await createWallet(api, '100', { playerId: a.playerId, currency: 'USD' });
    const refund = await submit(api, txBody(a, 'REFUND', '40', { reference: 'bet-1' }));
    await submit(api, txBody(b, 'BET', '40', { externalTransactionId: 'bet-1' }));

    // a BET foi em outra carteira, então a liberação imediata não alcança o REFUND
    expect((await statusOf(refund.body.transactionId)).status).toBe('PENDING_REFERENCE');
    expect(await worker().runOnce(later())).toMatchObject({ rejected: 1 });
    expect((await statusOf(refund.body.transactionId)).failureCode).toBe('REFERENCE_MISMATCH');
  });

  test('vários workers ao mesmo tempo (3 instâncias) tratam cada pendência uma vez só', async () => {
    const others = await Promise.all([startApi(), startApi()]);
    try {
      const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(api, '100')));
      for (const w of wallets) await submit(api, txBody(w, 'REFUND', '10', { reference: `bet-${w.id}` }));

      const workers = [api, ...others].map((i) => i.app.get(RetryPendingReferences));
      const now = later();
      const results = await Promise.all(workers.map((w) => w.runOnce(now)));
      // cada pendência foi reagendada exatamente uma vez; as outras instâncias pularam
      expect(results.reduce((n, r) => n + r.rescheduled, 0)).toBe(6);
      const attempts = await sql(`select reference_attempts from wager_transactions where kind = 'REFUND'`);
      expect(attempts.every((a) => a.reference_attempts === 1)).toBe(true);
    } finally {
      await Promise.all(others.map((o) => o.close()));
    }
  });
});
