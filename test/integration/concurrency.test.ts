import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetDatabase } from '../support/database';
import { checkInvariants } from '../support/invariants';
import { startApi, type ApiResponse, type TestApi } from '../support/api';
import { balanceOf, createWallet, submit, txBody, type TestWallet } from '../support/wagering';

// Três instâncias da aplicação, cada uma com o seu pool de conexões, sobre o mesmo
// banco: o que vale entre requisições paralelas precisa valer entre instâncias.
const INSTANCES = 3;
let instances: TestApi[] = [];

beforeAll(async () => {
  instances = await Promise.all(Array.from({ length: INSTANCES }, () => startApi()));
});

beforeEach(async () => {
  await resetDatabase(instances[0]!.orm);
});

// Invariante final de todos os cenários.
afterEach(async () => {
  expect(await checkInvariants(instances[0]!.orm)).toEqual([]);
});

afterAll(async () => {
  await Promise.all(instances.map((i) => i.close()));
});

const api = (n: number): TestApi => instances[n % INSTANCES]!;
const sql = (query: string, params: unknown[] = []) => instances[0]!.orm.em.getConnection().execute(query, params);

async function debits(walletId: string): Promise<number> {
  const [row] = await sql(
    `select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
    [walletId],
  );
  return row!.n as number;
}

describe('concorrência', () => {
  // Repetido para aumentar a chance de pegar uma corrida, se houvesse.
  test.each(Array.from({ length: 10 }, (_, i) => i + 1))(
    'cenário obrigatório: saldo 100.00, duas BET de 80.00 em paralelo em instâncias diferentes (rodada %i)',
    async (round) => {
      const w = await createWallet(api(0), '100.00');
      const results = await Promise.all([
        submit(api(round), txBody(w, 'BET', '80.00')),
        submit(api(round + 1), txBody(w, 'BET', '80.00')),
      ]);

      const processed = results.filter((r) => r.body.status === 'PROCESSED');
      const rejected = results.filter((r) => r.body.status === 'REJECTED');
      expect(processed).toHaveLength(1);
      expect(processed[0]!.status).toBe(201);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.status).toBe(422);
      expect(rejected[0]!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(api(0), w.id)).toBe('20.00');
      expect(await debits(w.id)).toBe(1);
    },
  );

  test('a mesma BET enviada 50 vezes em paralelo por 3 instâncias gera um único débito', async () => {
    const w = await createWallet(api(0), '100');
    const body = txBody(w, 'BET', '10');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(api(i), body)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    // Todas as respostas mostram o saldo observado pela única aplicação.
    expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(new Set(['90.00']));
    expect(await balanceOf(api(0), w.id)).toBe('90.00');
    expect(await debits(w.id)).toBe(1);
  });

  test('o mesmo REFUND enviado 30 vezes em paralelo gera um único crédito', async () => {
    const w = await createWallet(api(0), '100');
    await submit(api(0), txBody(w, 'BET', '40', { externalTransactionId: 'bet-1' }));
    const refund = txBody(w, 'REFUND', '40', { reference: 'bet-1' });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(api(i), refund)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await balanceOf(api(0), w.id)).toBe('100.00');
  });

  test('REFUND e ROLLBACK da mesma BET em paralelo: só uma reversão', async () => {
    const w = await createWallet(api(0), '100');
    await submit(api(0), txBody(w, 'BET', '10', { externalTransactionId: 'bet-1' }));
    const results = await Promise.all([
      submit(api(1), txBody(w, 'REFUND', '10', { reference: 'bet-1' })),
      submit(api(2), txBody(w, 'ROLLBACK', '10', { reference: 'bet-1' })),
    ]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.body.status === 'REJECTED')!.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(api(0), w.id)).toBe('100.00');
  });

  test('hot wallet: 60 BET concorrentes de 3 instâncias nunca deixam saldo negativo', async () => {
    const w = await createWallet(api(0), '100.00');
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => submit(api(i), txBody(w, 'BET', '7.00'))));
    const processed = results.filter((r) => r.body.status === 'PROCESSED');
    expect(processed).toHaveLength(14);
    expect(results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(46);
    expect(await balanceOf(api(0), w.id)).toBe('2.00');
    // Cada resposta processada viu um saldo distinto: as escritas foram serializadas.
    expect(new Set(processed.map((r) => r.body.balance.amount)).size).toBe(14);
  });

  test('wallets distintas em paralelo: carga mista com replays e reversões mantém as invariantes', async () => {
    const wallets: TestWallet[] = await Promise.all(Array.from({ length: 6 }, () => createWallet(api(0), '50')));
    const requests: Array<() => Promise<ApiResponse>> = [];

    for (const [wi, w] of wallets.entries()) {
      for (let i = 0; i < 10; i++) {
        const betId = `bet-${wi}-${i}`;
        // Valores que esgotam o saldo no meio do caminho, para gerar rejeições.
        const amount = `${(i % 4) + 3}.${i % 10}5`;
        const betBody = txBody(w, 'BET', amount, { externalTransactionId: betId });
        const follow =
          i % 3 === 0
            ? txBody(w, 'REFUND', amount, { reference: betId })
            : i % 3 === 1
              ? txBody(w, 'WIN', `${i}.10`, { reference: betId })
              : txBody(w, 'LOSS', '0', { reference: betId });
        const n = wi + i;
        requests.push(() => submit(api(n), betBody));
        requests.push(() => submit(api(n + 1), follow));
        // Replay da mesma BET por outra instância.
        requests.push(() => submit(api(n + 2), betBody));
      }
    }

    // Embaralha para misturar BET, dependentes (às vezes antes da BET) e replays.
    for (let i = requests.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [requests[i], requests[j]] = [requests[j]!, requests[i]!];
    }
    const results = await Promise.all(requests.map((r) => r()));
    expect(results.every((r) => [201, 202, 422].includes(r.status))).toBe(true);
  });
});

describe('checkInvariants', () => {
  // Garante que a verificação não é vazia: detecta uma divergência real.
  test('detecta saldo que não bate com o ledger', async () => {
    const w = await createWallet(api(0), '100');
    await sql('update wallets set balance = 99 where id = ?', [w.id]);
    const violations = await checkInvariants(instances[0]!.orm);
    expect(violations.map((v) => v.rule)).toContain('saldo = ledger');
    await sql('update wallets set balance = 100 where id = ?', [w.id]);
  });
});
