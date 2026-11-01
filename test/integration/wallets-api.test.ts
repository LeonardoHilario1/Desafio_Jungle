import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../support/database';
import { startApi, type TestApi } from '../support/api';
import { checkInvariants } from '../support/invariants';

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

const sql = (query: string, params: unknown[] = []) => api.orm.em.getConnection().execute(query, params);
const money = (amount: string, currency = 'BRL') => ({ amount, currency });

describe('POST /wallets', () => {
  test('cria carteira com saldo inicial no formato do desafio: version 1', async () => {
    const res = await api.post('/wallets', { playerId: 'p1', initialBalance: money('1000.00') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId: 'p1', balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('saldo inicial gera transação OPENING, lançamento CREDIT e eventos na mesma transação SQL', async () => {
    const res = await api.post('/wallets', { playerId: 'p1', initialBalance: money('100') });
    const transactions = await sql(
      'select kind, provider_id, status, amount, observed_balance from wager_transactions where wallet_id = ?',
      [res.body.id],
    );
    expect(transactions).toEqual([
      { kind: 'OPENING', provider_id: 'internal', status: 'PROCESSED', amount: '100.00', observed_balance: '100.00' },
    ]);
    const ledger = await sql(
      'select direction, amount, balance_before, balance_after, wallet_version from wallet_ledger_entries where wallet_id = ?',
      [res.body.id],
    );
    expect(ledger).toEqual([
      { direction: 'CREDIT', amount: '100.00', balance_before: '0.00', balance_after: '100.00', wallet_version: 1 },
    ]);
    const events = await sql('select event_type from outbox_messages order by event_type');
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await checkInvariants(api.orm)).toEqual([]);
  });

  test('saldo inicial zero não gera OPENING', async () => {
    const res = await api.post('/wallets', { playerId: 'p1', initialBalance: money('0') });
    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(await sql('select 1 from wager_transactions')).toEqual([]);
  });

  test('segunda carteira para o mesmo jogador e moeda responde 409 com o id existente', async () => {
    const first = await api.post('/wallets', { playerId: 'p1', initialBalance: money('10') });
    const second = await api.post('/wallets', { playerId: 'p1', initialBalance: money('10') });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', details: { walletId: first.body.id } });
    // Moeda diferente é outra carteira.
    expect((await api.post('/wallets', { playerId: 'p1', initialBalance: money('10', 'USD') })).status).toBe(201);
  });

  test('criações simultâneas: uma 201 e as demais 409, uma única OPENING', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.post('/wallets', { playerId: 'p-concorrente', initialBalance: money('50') })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await sql(`select 1 from wager_transactions where kind = 'OPENING'`)).toHaveLength(1);
  });

  test.each([
    [{ playerId: 'p', initialBalance: money('1', 'reais') }, 'INVALID_CURRENCY'],
    [{ playerId: '', initialBalance: money('1') }, 'INVALID_WALLET'],
    [{ initialBalance: money('1') }, 'INVALID_REQUEST'],
    [{ playerId: 'p' }, 'INVALID_REQUEST'],
    [{ playerId: 'p', initialBalance: '100.00' }, 'INVALID_REQUEST'],
    [{ playerId: 'p', initialBalance: { amount: 100, currency: 'BRL' } }, 'INVALID_REQUEST'],
    [{ playerId: 'p', initialBalance: money('-1') }, 'INVALID_AMOUNT'],
    [{ playerId: 'p', initialBalance: money('1.001') }, 'INVALID_AMOUNT'],
    [{ playerId: 'p', initialBalance: money('1e3') }, 'INVALID_AMOUNT'],
    [{ playerId: 'p', initialBalance: { ...money('1'), extra: 1 } }, 'INVALID_REQUEST'],
    [{ playerId: 'p', initialBalance: money('1'), extra: true }, 'INVALID_REQUEST'],
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

describe('GET /wallets/:walletId', () => {
  test('devolve a carteira', async () => {
    const created = await api.post('/wallets', { playerId: 'p1', initialBalance: money('7.5', 'USD') });
    const res = await api.get(`/wallets/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
    expect(res.body.balance).toEqual({ amount: '7.50', currency: 'USD' });
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
