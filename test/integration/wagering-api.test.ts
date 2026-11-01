import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../support/database';
import { startApi, type TestApi } from '../support/api';
import { checkInvariants } from '../support/invariants';
import { balanceOf, createWallet, submit, txBody } from '../support/wagering';

let api: TestApi;

beforeAll(async () => {
  api = await startApi();
});

beforeEach(async () => {
  await resetDatabase(api.orm);
});

// Invariante final de todos os testes: saldo = ledger, ledger encadeado, eventos gravados.
afterEach(async () => {
  expect(await checkInvariants(api.orm)).toEqual([]);
});

afterAll(async () => {
  await api.close();
});

const sql = (query: string, params: unknown[] = []) => api.orm.em.getConnection().execute(query, params);

async function ledger(walletId: string) {
  return sql(
    `select direction, amount, balance_before, balance_after from wallet_ledger_entries
      where wallet_id = ? order by wallet_version`,
    [walletId],
  );
}

describe('contrato do POST /wagering/transactions', () => {
  test('BET processada: 201 com transactionId, status, saldo e idempotentReplay', async () => {
    const w = await createWallet(api, '1000.00');
    const res = await submit(api, txBody(w, 'BET', '25.00', { externalTransactionId: 'transaction-123' }), 'provider-a:transaction-123');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect((await ledger(w.id)).slice(1)).toEqual([
      { direction: 'DEBIT', amount: '25.00', balance_before: '1000.00', balance_after: '975.00' },
    ]);
  });

  test('saldo insuficiente: 422 REJECTED com failureCode, sem lançamento', async () => {
    const w = await createWallet(api, '10');
    const res = await submit(api, txBody(w, 'BET', '10.01'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
    expect(await ledger(w.id)).toHaveLength(1);
  });

  test('cenário obrigatório em sequência: 100.00, duas BET de 80.00', async () => {
    const w = await createWallet(api, '100.00');
    const first = await submit(api, txBody(w, 'BET', '80.00'));
    const second = await submit(api, txBody(w, 'BET', '80.00'));
    expect([first.body.status, second.body.status]).toEqual(['PROCESSED', 'REJECTED']);
    expect(await balanceOf(api, w.id)).toBe('20.00');
  });
});

describe('idempotência', () => {
  test('requisição idêntica devolve a mesma resposta com idempotentReplay: true, sem debitar de novo', async () => {
    const w = await createWallet(api, '100');
    const body = txBody(w, 'BET', '30');
    const first = await submit(api, body);
    // Saldo muda depois; o replay devolve o saldo observado na primeira vez.
    await submit(api, txBody(w, 'WIN', '5'));
    const replay = await submit(api, { ...body, money: { amount: '30.00', currency: 'BRL' } });

    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('70.00');
    expect(await balanceOf(api, w.id)).toBe('75.00');
  });

  test('replay de uma rejeição continua rejeitado, mesmo com saldo novo', async () => {
    const w = await createWallet(api, '10');
    const body = txBody(w, 'BET', '50');
    expect((await submit(api, body)).status).toBe(422);
    await submit(api, txBody(w, 'WIN', '100'));
    const replay = await submit(api, body);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ status: 'REJECTED', idempotentReplay: true, failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('mesma key com payload diferente: 409 IDEMPOTENCY_KEY_CONFLICT, não replay', async () => {
    const w = await createWallet(api, '100');
    const body = txBody(w, 'BET', '30');
    const first = await submit(api, body);
    const conflict = await submit(api, { ...body, money: { amount: '31', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      details: { transactionId: first.body.transactionId },
    });
    expect(await balanceOf(api, w.id)).toBe('70.00');
  });

  test('mesmo id externo com outra key: 409 EXTERNAL_TRANSACTION_CONFLICT', async () => {
    const w = await createWallet(api, '100');
    const body = txBody(w, 'BET', '30');
    await submit(api, body);
    const res = await submit(api, body, 'outra-chave');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  test('mesma key em carteiras diferentes ao mesmo tempo: uma grava, as outras são conflito', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(api, '100')));
    const results = await Promise.all(
      wallets.map((w) => submit(api, txBody(w, 'BET', '10', { externalTransactionId: 'mesma' }), 'mesma-chave')),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  test('Idempotency-Key ausente responde 400', async () => {
    const w = await createWallet(api);
    const res = await submit(api, txBody(w, 'BET', '1'), null);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('WIN e LOSS', () => {
  test('WIN sem referência credita', async () => {
    const w = await createWallet(api, '0');
    const res = await submit(api, txBody(w, 'WIN', '12.34'));
    expect(res.status).toBe(201);
    expect(res.body.balance.amount).toBe('12.34');
  });

  test('WIN referenciando a BET da rodada credita e vincula', async () => {
    const w = await createWallet(api, '100');
    const bet = await submit(api, txBody(w, 'BET', '10', { externalTransactionId: 'bet-1' }));
    const win = await submit(api, txBody(w, 'WIN', '30', { reference: 'bet-1' }));
    expect(win.body.balance.amount).toBe('120.00');
    const detail = await api.get(`/wagering/transactions/${win.body.transactionId}`);
    expect(detail.body.referenceTransactionId).toBe(bet.body.transactionId);
  });

  test('LOSS é processada sem mover saldo nem gerar lançamento', async () => {
    const w = await createWallet(api, '100');
    await submit(api, txBody(w, 'BET', '10', { externalTransactionId: 'bet-1' }));
    const loss = await submit(api, txBody(w, 'LOSS', '0', { reference: 'bet-1' }));
    expect(loss.status).toBe(201);
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00' } });
    expect(await ledger(w.id)).toHaveLength(2);
  });

  test('WIN de outra rodada: 422 REFERENCE_MISMATCH', async () => {
    const w = await createWallet(api, '100');
    await submit(api, txBody(w, 'BET', '10', { externalTransactionId: 'bet-1' }));
    const win = await submit(api, txBody(w, 'WIN', '30', { reference: 'bet-1', roundId: 'outra' }));
    expect(win.status).toBe(422);
    expect(win.body.failureCode).toBe('REFERENCE_MISMATCH');
  });
});

describe('REFUND e ROLLBACK', () => {
  test('REFUND devolve a BET uma única vez', async () => {
    const w = await createWallet(api, '100');
    await submit(api, txBody(w, 'BET', '40', { externalTransactionId: 'bet-1' }));
    const refund = await submit(api, txBody(w, 'REFUND', '40', { reference: 'bet-1' }));
    expect(refund.status).toBe(201);
    expect(refund.body.balance.amount).toBe('100.00');

    const again = await submit(api, txBody(w, 'REFUND', '40', { reference: 'bet-1' }));
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    // Nem por outro tipo de operação: ROLLBACK da mesma BET também é recusado.
    const rollback = await submit(api, txBody(w, 'ROLLBACK', '40', { reference: 'bet-1' }));
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(api, w.id)).toBe('100.00');
  });

  test('REFUND com valor diferente: 422 REFERENCE_AMOUNT_MISMATCH', async () => {
    const w = await createWallet(api, '100');
    await submit(api, txBody(w, 'BET', '40', { externalTransactionId: 'bet-1' }));
    const refund = await submit(api, txBody(w, 'REFUND', '20', { reference: 'bet-1' }));
    expect(refund.body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
  });

  test('REFUND de WIN: 422 REFERENCE_KIND_NOT_ALLOWED', async () => {
    const w = await createWallet(api, '100');
    await submit(api, txBody(w, 'WIN', '40', { externalTransactionId: 'win-1' }));
    const refund = await submit(api, txBody(w, 'REFUND', '40', { reference: 'win-1' }));
    expect(refund.body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });

  test('ROLLBACK de WIN debita; de REFUND debita; de BET credita', async () => {
    const w = await createWallet(api, '100');
    await submit(api, txBody(w, 'WIN', '50', { externalTransactionId: 'win-1' }));
    expect((await submit(api, txBody(w, 'ROLLBACK', '50', { reference: 'win-1' }))).body.balance.amount).toBe('100.00');

    await submit(api, txBody(w, 'BET', '30', { externalTransactionId: 'bet-1' }));
    await submit(api, txBody(w, 'REFUND', '30', { externalTransactionId: 'refund-1', reference: 'bet-1' }));
    expect((await submit(api, txBody(w, 'ROLLBACK', '30', { reference: 'refund-1' }))).body.balance.amount).toBe('70.00');

    await submit(api, txBody(w, 'BET', '20', { externalTransactionId: 'bet-2' }));
    expect((await submit(api, txBody(w, 'ROLLBACK', '20', { reference: 'bet-2' }))).body.balance.amount).toBe('70.00');
  });

  test('ROLLBACK que deixaria saldo negativo: 422 REVERSAL_INSUFFICIENT_FUNDS, auditável', async () => {
    const w = await createWallet(api, '0');
    await submit(api, txBody(w, 'WIN', '50', { externalTransactionId: 'win-1' }));
    await submit(api, txBody(w, 'BET', '45'));
    const rollback = await submit(api, txBody(w, 'ROLLBACK', '50', { reference: 'win-1' }));
    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
    const [row] = await sql('select status, failure_code from wager_transactions where id = ?', [rollback.body.transactionId]);
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'REVERSAL_INSUFFICIENT_FUNDS' });
    expect(await balanceOf(api, w.id)).toBe('5.00');
  });

  test('REFUND antes da BET: 202 PENDING_REFERENCE, sem efeito no saldo', async () => {
    const w = await createWallet(api, '100');
    const refund = await submit(api, txBody(w, 'REFUND', '40', { reference: 'bet-tardia' }));
    expect(refund.status).toBe(202);
    expect(refund.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
    expect(await balanceOf(api, w.id)).toBe('100.00');
  });
});

describe('validação e conflitos de carteira', () => {
  test('carteira inexistente responde 404', async () => {
    const res = await submit(api, txBody({ id: crypto.randomUUID(), playerId: 'p', currency: 'BRL' }, 'BET', '1'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('moeda diferente da carteira: 422 CURRENCY_MISMATCH, gravada para auditoria', async () => {
    const w = await createWallet(api, '100');
    const res = await submit(api, txBody(w, 'BET', '1', { currency: 'USD' }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH', balance: { amount: '100.00', currency: 'BRL' } });
    expect(await balanceOf(api, w.id)).toBe('100.00');
  });

  test('jogador diferente do dono: 422 PLAYER_MISMATCH', async () => {
    const w = await createWallet(api, '100');
    const res = await submit(api, txBody(w, 'BET', '1', { playerId: 'outro-jogador' }));
    expect(res.body.failureCode).toBe('PLAYER_MISMATCH');
  });

  test.each([
    ['money numérico', (b: Record<string, unknown>) => ({ ...b, money: { amount: 10, currency: 'BRL' } }), 'INVALID_REQUEST'],
    ['money como string', (b: Record<string, unknown>) => ({ ...b, money: '10.00' }), 'INVALID_REQUEST'],
    ['amount com 3 casas', (b: Record<string, unknown>) => ({ ...b, money: { amount: '1.001', currency: 'BRL' } }), 'INVALID_AMOUNT'],
    ['amount negativo', (b: Record<string, unknown>) => ({ ...b, money: { amount: '-1', currency: 'BRL' } }), 'INVALID_AMOUNT'],
    ['notação científica', (b: Record<string, unknown>) => ({ ...b, money: { amount: '1e2', currency: 'BRL' } }), 'INVALID_AMOUNT'],
    ['kind OPENING', (b: Record<string, unknown>) => ({ ...b, kind: 'OPENING' }), 'INVALID_TRANSACTION'],
    ['kind desconhecido', (b: Record<string, unknown>) => ({ ...b, kind: 'JACKPOT' }), 'INVALID_TRANSACTION'],
    ['REFUND sem referência', (b: Record<string, unknown>) => ({ ...b, kind: 'REFUND' }), 'INVALID_TRANSACTION'],
    ['sem roundId', ({ roundId: _, ...b }: Record<string, unknown>) => b, 'INVALID_REQUEST'],
    ['campo desconhecido', (b: Record<string, unknown>) => ({ ...b, extra: 1 }), 'INVALID_REQUEST'],
    ['walletId malformado', (b: Record<string, unknown>) => ({ ...b, walletId: 'x' }), 'INVALID_REQUEST'],
  ])('400 para %s', async (_, change, code) => {
    const w = await createWallet(api, '100');
    const res = await submit(api, change(txBody(w, 'BET', '10')));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });
});

describe('consultas de transação', () => {
  test('GET por id interno e por (providerId, externalTransactionId)', async () => {
    const w = await createWallet(api, '100');
    const res = await submit(api, txBody(w, 'BET', '10', { externalTransactionId: 'transaction-123' }));

    const byId = await api.get(`/wagering/transactions/${res.body.transactionId}`);
    const byExternal = await api.get('/providers/provider-a/wagering/transactions/transaction-123');
    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      status: 'PROCESSED',
      balance: { amount: '90.00', currency: 'BRL' },
    });
  });

  test('404 TRANSACTION_NOT_FOUND', async () => {
    expect((await api.get(`/wagering/transactions/${crypto.randomUUID()}`)).body.error.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await api.get('/providers/provider-a/wagering/transactions/nada')).status).toBe(404);
  });
});

test('correlationId do header X-Correlation-Id é gravado e propagado aos eventos', async () => {
  const w = await createWallet(api, '100');
  const body = txBody(w, 'BET', '10');
  const res = await api.post('/wagering/transactions', body, {
    'idempotency-key': `provider-a:${body.externalTransactionId}`,
    'x-correlation-id': 'corr-abc',
  });
  const detail = await api.get(`/wagering/transactions/${res.body.transactionId}`);
  expect(detail.body.correlationId).toBe('corr-abc');
  const events = await sql(`select payload ->> 'correlationId' as c from outbox_messages where payload -> 'data' ->> 'transactionId' = ?`, [
    res.body.transactionId,
  ]);
  expect(events.map((e) => e.c)).toEqual(['corr-abc', 'corr-abc']);
});
