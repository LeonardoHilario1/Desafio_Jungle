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

describe('POST /wallets', () => {
  test('cria carteira com saldo zero', async () => {
    const res = await api.post('/wallets', { playerId: 'p1', currency: 'BRL' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId: 'p1', currency: 'BRL', balance: '0.00', version: 1 });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('cria carteira com saldo inicial e lançamento de abertura no ledger', async () => {
    const res = await api.post('/wallets', { playerId: 'p1', currency: 'BRL', initialBalance: '100' });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe('100.00');

    const rows = await api.orm.em
      .getConnection()
      .execute('select kind, direction, amount, balance_after, transaction_id from wallet_ledger_entries where wallet_id = ?', [
        res.body.id,
      ]);
    expect(rows).toEqual([
      { kind: 'OPENING', direction: 'CREDIT', amount: '100.00', balance_after: '100.00', transaction_id: null },
    ]);
  });

  test('segunda carteira para o mesmo jogador e moeda responde 409 com o id existente', async () => {
    const first = await api.post('/wallets', { playerId: 'p1', currency: 'BRL' });
    const second = await api.post('/wallets', { playerId: 'p1', currency: 'BRL' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', details: { walletId: first.body.id } });
  });

  test('criações simultâneas: uma 201 e as demais 409', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.post('/wallets', { playerId: 'p-concorrente', currency: 'BRL' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });

  test.each([
    [{ playerId: 'p', currency: 'reais' }, 'INVALID_CURRENCY'],
    [{ playerId: '', currency: 'BRL' }, 'INVALID_WALLET'],
    [{ currency: 'BRL' }, 'INVALID_REQUEST'],
    [{ playerId: 'p', currency: 'BRL', initialBalance: 100 }, 'INVALID_REQUEST'],
    [{ playerId: 'p', currency: 'BRL', initialBalance: '-1' }, 'INVALID_AMOUNT'],
    [{ playerId: 'p', currency: 'BRL', extra: true }, 'INVALID_REQUEST'],
  ])('entrada inválida %p responde 400 %s', async (body, code) => {
    const res = await api.post('/wallets', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  test('JSON malformado responde 400 INVALID_REQUEST', async () => {
    const res = await api.post('/wallets', '{"playerId":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});

describe('GET /wallets/:id', () => {
  test('devolve a carteira', async () => {
    const created = await api.post('/wallets', { playerId: 'p1', currency: 'USD', initialBalance: '7.5' });
    const res = await api.get(`/wallets/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  test('404 para carteira inexistente e 400 para id malformado', async () => {
    const missing = await api.get(`/wallets/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');

    const malformed = await api.get('/wallets/nao-e-uuid');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_REQUEST');
  });
});
