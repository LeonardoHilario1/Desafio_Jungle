import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../support/database';
import { startApi, type TestApi } from '../support/api';

let api: TestApi;

beforeAll(async () => {
  api = await startApi();
});

beforeEach(async () => {
  await resetDatabase(api.orm);
});

afterAll(async () => {
  await api.close();
});

async function wallet(initialBalance = '100', currency = 'BRL'): Promise<string> {
  const res = await api.post('/wallets', { playerId: `p-${crypto.randomUUID()}`, currency, initialBalance });
  expect(res.status).toBe(201);
  return res.body.id;
}

function submit(key: string | null, body: Record<string, unknown>) {
  return api.post('/wagering/transactions', body, key === null ? {} : { 'idempotency-key': key });
}

const bet = (walletId: string, amount: string) => ({ walletId, type: 'BET', amount, currency: 'BRL' });
const win = (walletId: string, amount: string, referenceKey: string) => ({
  walletId,
  type: 'WIN',
  amount,
  currency: 'BRL',
  referenceKey,
});
const loss = (walletId: string, referenceKey: string) => ({
  walletId,
  type: 'LOSS',
  amount: '0',
  currency: 'BRL',
  referenceKey,
});

async function balance(walletId: string): Promise<string> {
  return (await api.get(`/wallets/${walletId}`)).body.balance;
}

async function ledger(walletId: string) {
  return api.orm.em
    .getConnection()
    .execute(
      `select kind, direction, amount, balance_after from wallet_ledger_entries where wallet_id = ? order by created_at, (kind = 'TRANSACTION')`,
      [walletId],
    );
}

describe('BET', () => {
  test('processa, debita e grava um lançamento', async () => {
    const w = await wallet('100');
    const res = await submit('bet-1', bet(w, '30.5'));

    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBe('false');
    expect(res.body).toMatchObject({
      idempotencyKey: 'bet-1',
      walletId: w,
      type: 'BET',
      amount: '30.50',
      currency: 'BRL',
      status: 'PROCESSED',
      failureCode: null,
    });
    expect(await balance(w)).toBe('69.50');
    expect(await ledger(w)).toEqual([
      { kind: 'OPENING', direction: 'CREDIT', amount: '100.00', balance_after: '100.00' },
      { kind: 'TRANSACTION', direction: 'DEBIT', amount: '30.50', balance_after: '69.50' },
    ]);
  });

  test('saldo insuficiente: grava REJECTED com failureCode e responde 422', async () => {
    const w = await wallet('10');
    const res = await submit('bet-1', bet(w, '10.01'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(await balance(w)).toBe('10.00');
    expect(await ledger(w)).toHaveLength(1);
  });
});

describe('idempotência', () => {
  test('replay devolve a mesma resposta sem debitar de novo', async () => {
    const w = await wallet('100');
    const first = await submit('bet-1', bet(w, '30'));
    const replay = await submit('bet-1', bet(w, '30.00'));

    expect(replay.status).toBe(first.status);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await balance(w)).toBe('70.00');
  });

  test('replay de uma rejeição continua rejeitado, mesmo com saldo novo', async () => {
    const w = await wallet('10');
    const first = await submit('bet-1', bet(w, '50'));
    expect(first.status).toBe(422);
    const replay = await submit('bet-1', bet(w, '50'));
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual(first.body);
  });

  test('mesma chave com payload diferente responde 409', async () => {
    const w = await wallet('100');
    await submit('bet-1', bet(w, '30'));
    const conflict = await submit('bet-1', bet(w, '31'));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await balance(w)).toBe('70.00');
  });

  test('mesma chave em carteiras diferentes ao mesmo tempo: uma processa, as outras são conflito', async () => {
    const wallets = await Promise.all([wallet(), wallet(), wallet(), wallet()]);
    const results = await Promise.all(wallets.map((w) => submit('mesma-chave', bet(w, '10'))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  test('Idempotency-Key ausente responde 400', async () => {
    const w = await wallet();
    const res = await submit(null, bet(w, '1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('WIN e LOSS', () => {
  test('WIN credita e liquida a BET', async () => {
    const w = await wallet('100');
    await submit('bet-1', bet(w, '40'));
    const res = await submit('win-1', win(w, '95.25', 'bet-1'));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PROCESSED');
    expect(await balance(w)).toBe('155.25');
  });

  test('LOSS liquida a BET sem mover dinheiro', async () => {
    const w = await wallet('100');
    await submit('bet-1', bet(w, '40'));
    const res = await submit('loss-1', loss(w, 'bet-1'));
    expect(res.status).toBe(201);
    expect(await balance(w)).toBe('60.00');
    expect(await ledger(w)).toHaveLength(2);
  });

  test('segunda liquidação da mesma BET é rejeitada', async () => {
    const w = await wallet('100');
    await submit('bet-1', bet(w, '40'));
    await submit('win-1', win(w, '80', 'bet-1'));
    const second = await submit('loss-1', loss(w, 'bet-1'));
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('BET_ALREADY_SETTLED');
    expect(await balance(w)).toBe('140.00');
  });

  test('WIN antes da BET fica PENDING_REFERENCE (202) e não credita', async () => {
    const w = await wallet('100');
    const res = await submit('win-1', win(w, '50', 'bet-que-nao-chegou'));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
    expect(await balance(w)).toBe('100.00');
  });

  test('WIN de BET rejeitada é rejeitada', async () => {
    const w = await wallet('10');
    await submit('bet-1', bet(w, '50'));
    const res = await submit('win-1', win(w, '100', 'bet-1'));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    expect(await balance(w)).toBe('10.00');
  });

  test('WIN referenciando BET de outra carteira é rejeitada', async () => {
    const a = await wallet('100');
    const b = await wallet('100');
    await submit('bet-a', bet(a, '10'));
    const res = await submit('win-b', win(b, '20', 'bet-a'));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('REFERENCE_WALLET_MISMATCH');
    expect(await balance(b)).toBe('100.00');
  });
});

describe('validação', () => {
  test('carteira inexistente responde 404', async () => {
    const res = await submit('k', bet(crypto.randomUUID(), '1'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('moeda diferente da carteira responde 422 sem gravar', async () => {
    const w = await wallet('100', 'USD');
    const res = await submit('k', bet(w, '1'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CURRENCY_MISMATCH');
    const [row] = await api.orm.em.getConnection().execute('select count(*)::int as n from wager_transactions');
    expect(row).toEqual({ n: 0 });
  });

  test.each([
    ['amount como number', { type: 'BET', amount: 10, currency: 'BRL' }, 'INVALID_REQUEST'],
    ['amount com 3 casas', { type: 'BET', amount: '1.001', currency: 'BRL' }, 'INVALID_AMOUNT'],
    ['tipo fora do MVP', { type: 'REFUND', amount: '1', currency: 'BRL' }, 'INVALID_TRANSACTION'],
    ['BET com referenceKey', { type: 'BET', amount: '1', currency: 'BRL', referenceKey: 'x' }, 'INVALID_TRANSACTION'],
    ['WIN sem referenceKey', { type: 'WIN', amount: '1', currency: 'BRL' }, 'INVALID_TRANSACTION'],
    ['campo desconhecido', { type: 'BET', amount: '1', currency: 'BRL', roundId: 'r' }, 'INVALID_REQUEST'],
  ])('%s responde 400 %s', async (_, body, code) => {
    const w = await wallet();
    const res = await submit('k', { walletId: w, ...body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });
});
