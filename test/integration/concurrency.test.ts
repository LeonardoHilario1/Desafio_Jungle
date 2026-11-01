import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../support/database';
import { checkInvariants } from '../support/invariants';
import { startApi, type ApiResponse, type TestApi } from '../support/api';

// Duas instâncias da aplicação, cada uma com o seu pool de conexões, sobre o mesmo
// banco: o que vale entre requisições paralelas precisa valer entre instâncias.
let instanceA: TestApi;
let instanceB: TestApi;

beforeAll(async () => {
  [instanceA, instanceB] = await Promise.all([startApi(), startApi()]);
});

beforeEach(async () => {
  await resetDatabase(instanceA.orm);
});

afterAll(async () => {
  await Promise.all([instanceA.close(), instanceB.close()]);
});

const instances = () => [instanceA, instanceB];
const sql = (query: string, params: unknown[] = []) => instanceA.orm.em.getConnection().execute(query, params);

async function wallet(initialBalance: string): Promise<string> {
  const res = await instanceA.post('/wallets', { playerId: `p-${crypto.randomUUID()}`, currency: 'BRL', initialBalance });
  expect(res.status).toBe(201);
  return res.body.id;
}

function submit(api: TestApi, key: string, body: Record<string, unknown>): Promise<ApiResponse> {
  return api.post('/wagering/transactions', body, { 'idempotency-key': key });
}

const bet = (walletId: string, amount: string) => ({ walletId, type: 'BET', amount, currency: 'BRL' });

async function debits(walletId: string): Promise<number> {
  const [row] = await sql(
    `select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
    [walletId],
  );
  return row!.n as number;
}

async function balance(walletId: string): Promise<string> {
  return (await instanceA.get(`/wallets/${walletId}`)).body.balance;
}

describe('concorrência', () => {
  // Repetido para aumentar a chance de pegar uma corrida, se houvesse.
  test.each(Array.from({ length: 10 }, (_, i) => i + 1))(
    'saldo 100, duas BET de 80 em paralelo em instâncias diferentes (rodada %i)',
    async () => {
      const w = await wallet('100');
      const results = await Promise.all([
        submit(instanceA, `bet-a-${w}`, bet(w, '80')),
        submit(instanceB, `bet-b-${w}`, bet(w, '80')),
      ]);

      const processed = results.filter((r) => r.body.status === 'PROCESSED');
      const rejected = results.filter((r) => r.body.status === 'REJECTED');
      expect(processed).toHaveLength(1);
      expect(processed[0]!.status).toBe(201);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.status).toBe(422);
      expect(rejected[0]!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balance(w)).toBe('20.00');
      expect(await debits(w)).toBe(1);
      expect(await checkInvariants(instanceA.orm)).toEqual([]);
    },
  );

  test('a mesma BET enviada 50 vezes em paralelo gera um único débito', async () => {
    const w = await wallet('100');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submit(instances()[i % 2]!, 'mesma-bet', bet(w, '10'))),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.headers.get('idempotent-replayed') === 'false')).toHaveLength(1);
    expect(results.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(49);
    expect(await balance(w)).toBe('90.00');
    expect(await debits(w)).toBe(1);
    const [row] = await sql(`select count(*)::int as n from wager_transactions where idempotency_key = 'mesma-bet'`);
    expect(row).toEqual({ n: 1 });
    expect(await checkInvariants(instanceA.orm)).toEqual([]);
  });

  test('a mesma WIN enviada 50 vezes em paralelo gera um único crédito', async () => {
    const w = await wallet('100');
    await submit(instanceA, 'bet-1', bet(w, '10'));
    const win = { walletId: w, type: 'WIN', amount: '25.50', currency: 'BRL', referenceKey: 'bet-1' };
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(instances()[i % 2]!, 'win-1', win)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await balance(w)).toBe('115.50');
    expect(await checkInvariants(instanceA.orm)).toEqual([]);
  });

  test('WIN e LOSS da mesma BET em paralelo: só uma liquida', async () => {
    const w = await wallet('100');
    await submit(instanceA, 'bet-1', bet(w, '10'));
    const [winRes, lossRes] = await Promise.all([
      submit(instanceA, 'win-1', { walletId: w, type: 'WIN', amount: '30', currency: 'BRL', referenceKey: 'bet-1' }),
      submit(instanceB, 'loss-1', { walletId: w, type: 'LOSS', amount: '0', currency: 'BRL', referenceKey: 'bet-1' }),
    ]);

    const statuses = [winRes!.body.status, lossRes!.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const loser = winRes!.body.status === 'REJECTED' ? winRes! : lossRes!;
    expect(loser.body.failureCode).toBe('BET_ALREADY_SETTLED');
    expect(await balance(w)).toBe(winRes!.body.status === 'PROCESSED' ? '120.00' : '90.00');
    expect(await checkInvariants(instanceA.orm)).toEqual([]);
  });

  test('carga mista em várias carteiras, com replays, mantém todas as invariantes', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wallet('50')));
    const requests: Array<() => Promise<ApiResponse>> = [];

    for (const [wi, w] of wallets.entries()) {
      for (let i = 0; i < 12; i++) {
        const betKey = `bet-${wi}-${i}`;
        // Valores que esgotam o saldo no meio do caminho, para gerar rejeições.
        const amount = `${(i % 4) + 3}.${i % 10}5`;
        const settle =
          i % 3 === 0
            ? { walletId: w, type: 'LOSS', amount: '0', currency: 'BRL', referenceKey: betKey }
            : { walletId: w, type: 'WIN', amount: `${i}.10`, currency: 'BRL', referenceKey: betKey };
        const api = instances()[(wi + i) % 2]!;
        requests.push(() => submit(api, betKey, bet(w, amount)));
        requests.push(() => submit(api, `settle-${wi}-${i}`, settle));
        // Replay da mesma BET pela outra instância.
        requests.push(() => submit(instances()[(wi + i + 1) % 2]!, betKey, bet(w, amount)));
      }
    }

    // Embaralha para misturar BET, liquidação (às vezes antes da BET) e replays.
    for (let i = requests.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [requests[i], requests[j]] = [requests[j]!, requests[i]!];
    }
    const results = await Promise.all(requests.map((r) => r()));

    expect(results.every((r) => [201, 202, 422].includes(r.status))).toBe(true);
    expect(await checkInvariants(instanceA.orm)).toEqual([]);
  });
});

describe('checkInvariants', () => {
  // Garante que a verificação não é vazia: detecta uma divergência real.
  test('detecta saldo que não bate com o ledger', async () => {
    const w = await wallet('100');
    await sql('update wallets set balance = 99 where id = ?', [w]);
    const violations = await checkInvariants(instanceA.orm);
    expect(violations.map((v) => v.rule)).toContain('saldo = ledger');
  });
});
