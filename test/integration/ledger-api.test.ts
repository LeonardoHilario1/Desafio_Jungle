import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../support/database';
import { startApi, type TestApi } from '../support/api';
import { createWallet, submit, txBody } from '../support/wagering';

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

describe('GET /wallets/:walletId/ledger', () => {
  test('lista os lançamentos em ordem, com saldo antes e depois', async () => {
    const w = await createWallet(api, '100');
    const bet = await submit(api, txBody(w, 'BET', '30'));
    await submit(api, txBody(w, 'LOSS', '0'));
    await submit(api, txBody(w, 'WIN', '5'));

    const res = await api.get(`/wallets/${w.id}/ledger`);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([1, 2, 3]);
    expect(res.body.items[1]).toMatchObject({
      transactionId: bet.body.transactionId,
      direction: 'DEBIT',
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
    });
  });

  test('pagina com cursor estável, mesmo com lançamentos novos entre as páginas', async () => {
    const w = await createWallet(api, '100');
    for (let i = 0; i < 6; i++) await submit(api, txBody(w, 'BET', '1'));

    const first = await api.get(`/wallets/${w.id}/ledger?limit=3`);
    expect(first.body.items).toHaveLength(3);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    // lançamento novo no meio da paginação não duplica nem pula itens
    await submit(api, txBody(w, 'WIN', '2'));

    const second = await api.get(`/wallets/${w.id}/ledger?limit=3&cursor=${first.body.nextCursor}`);
    const third = await api.get(`/wallets/${w.id}/ledger?limit=3&cursor=${second.body.nextCursor}`);
    expect(third.body.nextCursor).toBeNull();
    const versions = [...first.body.items, ...second.body.items, ...third.body.items].map(
      (e: { walletVersion: number }) => e.walletVersion,
    );
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('carteira sem lançamentos devolve página vazia', async () => {
    const w = await createWallet(api, '0');
    expect((await api.get(`/wallets/${w.id}/ledger`)).body).toEqual({ items: [], nextCursor: null });
  });

  test.each([
    ['cursor que não é base64 de JSON', 'cursor=%%%'],
    ['cursor com versão negativa', `cursor=${Buffer.from('{"v":-1}').toString('base64url')}`],
    ['limit zero', 'limit=0'],
    ['limit acima de 200', 'limit=201'],
    ['limit não numérico', 'limit=dez'],
  ])('400 para %s', async (_, query) => {
    const w = await createWallet(api, '0');
    const res = await api.get(`/wallets/${w.id}/ledger?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('404 para carteira inexistente', async () => {
    expect((await api.get(`/wallets/${crypto.randomUUID()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('carteira consistente', async () => {
    const w = await createWallet(api, '1000');
    await submit(api, txBody(w, 'BET', '25'));

    const res = await api.post(`/wallets/${w.id}/reconciliation`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada, não corrigida', async () => {
    const w = await createWallet(api, '100');
    // simula uma corrupção fora da aplicação
    await sql('update wallets set balance = 90 where id = ?', [w.id]);

    const res = await api.post(`/wallets/${w.id}/reconciliation`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storedBalance: { amount: '90.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '-10.00' },
      consistent: false,
    });
    // nada foi corrigido em silêncio
    const [row] = await sql('select balance from wallets where id = ?', [w.id]);
    expect(row).toEqual({ balance: '90.00' });
  });

  test('404 para carteira inexistente', async () => {
    const res = await api.post(`/wallets/${crypto.randomUUID()}/reconciliation`, {});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});
