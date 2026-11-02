import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction, type WagerTransactionCommand } from '../../src/aplicacao/processar-transacao-aposta';
import { Money } from '../../src/dominio/dinheiro';
import { DEFAULT_REFERENCE_RETRY } from '../../src/dominio/politica-referencia';
import { Wallet } from '../../src/dominio/carteira';
import { MikroOrmWageringUnitOfWork } from '../../src/persistencia/repositorio-apostas-mikro-orm';
import { expectSqlState, initTestOrm, resetDatabase } from '../support/database';

// SQLSTATEs do PostgreSQL usados nas asserções.
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RAISED_EXCEPTION = 'P0001';

let orm: MikroORM;
let uow: MikroOrmWageringUnitOfWork;
let processWager: ProcessWagerTransaction;

beforeAll(async () => {
  orm = await initTestOrm();
  uow = new MikroOrmWageringUnitOfWork(orm);
  processWager = new ProcessWagerTransaction(uow, DEFAULT_REFERENCE_RETRY);
});

beforeEach(async () => {
  await resetDatabase(orm);
});

afterAll(async () => {
  await orm.close(true);
});

const sql = (query: string, params: unknown[] = []) => orm.em.getConnection().execute(query, params);
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

async function openWallet(amount = '100', playerId = `player-${crypto.randomUUID()}`): Promise<Wallet> {
  const opened = Wallet.open({ playerId, initialBalance: brl(amount) });
  await uow.run((store) => store.insertWallet(opened, []));
  return opened.wallet;
}

let seq = 0;
async function wager(wallet: Wallet, overrides: Partial<WagerTransactionCommand> = {}) {
  seq += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${seq}`;
  const { transaction } = await processWager.execute(
    {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10', currency: 'BRL' },
      referenceExternalTransactionId: null,
      ...overrides,
      externalTransactionId,
    },
    { correlationId: 'corr' },
  );
  return transaction;
}

/** INSERT direto em wager_transactions com uma linha válida; cada teste muda só o que testa. */
function insertTransaction(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const row: Record<string, unknown> = {
    id: crypto.randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: `raw-${seq}`,
    idempotency_key: `raw-key-${seq}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: wallet.id,
    player_id: wallet.playerId,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    currency: 'BRL',
    amount: '10',
    correlation_id: 'corr',
    status: 'PENDING',
    ...overrides,
  };
  const columns = Object.keys(row);
  return sql(
    `insert into wager_transactions (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  ).then(() => row.id as string);
}

function insertEntry(wallet: Wallet, transactionId: string, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: crypto.randomUUID(),
    wallet_id: wallet.id,
    transaction_id: transactionId,
    direction: 'DEBIT',
    currency: 'BRL',
    amount: '10',
    balance_before: '100',
    balance_after: '90',
    wallet_version: 50,
    ...overrides,
  };
  const columns = Object.keys(row);
  return sql(
    `insert into wallet_ledger_entries (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}

describe('mapeamento ORM', () => {
  test('grava e relê carteira, transação e lançamento com Money exato', async () => {
    const wallet = await openWallet('100');
    const bet = await wager(wallet, { money: { amount: '80', currency: 'BRL' } });

    const reloaded = await uow.read(async (store) => ({
      wallet: await store.findWallet(wallet.id),
      bet: await store.findTransaction(bet.id),
    }));
    expect(reloaded.wallet!.balance.equals(brl('20'))).toBe(true);
    expect(reloaded.wallet!.version).toBe(2);
    expect(reloaded.bet!.status).toBe('PROCESSED');
    expect(reloaded.bet!.money.amount).toBe('80.00');
    expect(reloaded.bet!.observedBalance!.amount).toBe('20.00');
    expect(reloaded.bet!.payloadHash).toBe(bet.payloadHash);

    // O driver devolve numeric como string; nada passa por number.
    const rows = await sql(
      `select direction, amount, balance_before, balance_after, wallet_version from wallet_ledger_entries
        where wallet_id = ? order by wallet_version`,
      [wallet.id],
    );
    expect(rows).toEqual([
      { direction: 'CREDIT', amount: '100.00', balance_before: '0.00', balance_after: '100.00', wallet_version: 1 },
      { direction: 'DEBIT', amount: '80.00', balance_before: '100.00', balance_after: '20.00', wallet_version: 2 },
    ]);
  });
});

describe('wallets', () => {
  test('uma carteira por jogador e moeda', async () => {
    await openWallet('0', 'p1');
    const usd = Wallet.open({ playerId: 'p1', initialBalance: Money.from({ amount: '0', currency: 'USD' }) });
    await uow.run((store) => store.insertWallet(usd, []));
    await expectSqlState(
      sql(`insert into wallets (id, player_id, currency, balance, version) values (gen_random_uuid(), 'p1', 'BRL', 0, 1)`),
      UNIQUE_VIOLATION,
      'wallets_player_currency_uq',
    );
  });

  test('saldo não pode ficar negativo', async () => {
    const wallet = await openWallet();
    await expectSqlState(
      sql('update wallets set balance = -0.01 where id = ?', [wallet.id]),
      CHECK_VIOLATION,
      'wallets_balance_non_negative_ck',
    );
  });

  test('moeda precisa ser ISO de 3 letras', async () => {
    await expectSqlState(
      sql(`insert into wallets (id, player_id, currency, balance, version) values (gen_random_uuid(), 'p', 'br1', 0, 1)`),
      CHECK_VIOLATION,
      'wallets_currency_ck',
    );
  });
});

describe('wager_transactions', () => {
  test('Idempotency-Key e (provider_id, external_transaction_id) são únicos', async () => {
    const wallet = await openWallet();
    await insertTransaction(wallet, { idempotency_key: 'k', external_transaction_id: 'e1' });
    await expectSqlState(
      insertTransaction(wallet, { idempotency_key: 'k' }),
      UNIQUE_VIOLATION,
      'wager_transactions_idempotency_key_uq',
    );
    await expectSqlState(
      insertTransaction(wallet, { external_transaction_id: 'e1' }),
      UNIQUE_VIOLATION,
      'wager_transactions_provider_external_uq',
    );
    // Mesmo id externo em outro provedor é outra transação.
    await insertTransaction(wallet, { external_transaction_id: 'e1', provider_id: 'provider-b' });
  });

  test.each([
    ['BET com referência', { reference_external_transaction_id: 'x' }, 'wager_transactions_shape_ck'],
    ['BET de valor zero', { amount: '0' }, 'wager_transactions_shape_ck'],
    ['REFUND sem referência', { kind: 'REFUND' }, 'wager_transactions_shape_ck'],
    ['valor negativo', { kind: 'LOSS', amount: '-1' }, 'wager_transactions_amount_non_negative_ck'],
    ['provedor interno fora da OPENING', { provider_id: 'internal' }, 'wager_transactions_internal_ck'],
    ['sem rodada', { round_id: null }, 'wager_transactions_round_game_ck'],
    ['REJECTED sem failure_code', { status: 'REJECTED', processed_at: new Date(), observed_balance: '1', observed_currency: 'BRL' }, 'wager_transactions_failure_code_ck'],
    ['PROCESSED sem processed_at', { status: 'PROCESSED', observed_balance: '1', observed_currency: 'BRL' }, 'wager_transactions_processed_at_ck'],
    ['PROCESSED sem saldo observado', { status: 'PROCESSED', processed_at: new Date() }, 'wager_transactions_observed_balance_ck'],
    ['saldo observado sem moeda', { observed_balance: '1' }, 'wager_transactions_observed_currency_ck'],
    ['PENDING_REFERENCE sem referência', { status: 'PENDING_REFERENCE', observed_balance: '1', observed_currency: 'BRL' }, 'wager_transactions_pending_reference_ck'],
    ['kind desconhecido', { kind: 'JACKPOT' }, 'wager_transactions_kind_ck'],
  ])('CHECK: %s', async (_, overrides, constraint) => {
    const wallet = await openWallet();
    await expectSqlState(insertTransaction(wallet, overrides), CHECK_VIOLATION, constraint);
  });

  test('transação com moeda diferente da carteira é gravada REJECTED (auditável)', async () => {
    const wallet = await openWallet();
    const usd = await wager(wallet, { money: { amount: '1', currency: 'USD' } });
    expect(usd.status).toBe('REJECTED');
    expect(usd.failureCode).toBe('CURRENCY_MISMATCH');
    const [row] = await sql('select currency, observed_currency from wager_transactions where id = ?', [usd.id]);
    expect(row).toEqual({ currency: 'USD', observed_currency: 'BRL' });
  });

  test('estado terminal não muda', async () => {
    const wallet = await openWallet();
    const bet = await wager(wallet);
    await expectSqlState(
      sql(`update wager_transactions set status = 'FAILED', failure_code = 'PROCESSING_FAILED' where id = ?`, [bet.id]),
      RAISED_EXCEPTION,
      'estado terminal',
    );
  });

  test('campos de negócio são imutáveis mesmo em estado aberto; PENDING_REFERENCE não volta a PENDING', async () => {
    const wallet = await openWallet();
    const refund = await wager(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'nao-chegou' });
    expect(refund.status).toBe('PENDING_REFERENCE');
    await expectSqlState(sql('update wager_transactions set amount = 2 where id = ?', [refund.id]), RAISED_EXCEPTION, 'imutáveis');
    await expectSqlState(
      sql(`update wager_transactions set status = 'PENDING' where id = ?`, [refund.id]),
      RAISED_EXCEPTION,
      'PENDING_REFERENCE',
    );
  });

  test('não permite DELETE nem TRUNCATE', async () => {
    const wallet = await openWallet();
    const bet = await wager(wallet);
    await expectSqlState(sql('delete from wager_transactions where id = ?', [bet.id]), RAISED_EXCEPTION);
    await expectSqlState(sql('truncate wager_transactions cascade'), RAISED_EXCEPTION);
  });

  test('uma OPENING por carteira', async () => {
    const wallet = await openWallet('100');
    await expectSqlState(
      insertTransaction(wallet, {
        provider_id: 'internal',
        kind: 'OPENING',
        round_id: null,
        game_id: null,
        status: 'PROCESSED',
        processed_at: new Date(),
        observed_balance: '10',
        observed_currency: 'BRL',
      }),
      UNIQUE_VIOLATION,
      'wager_transactions_one_opening_uq',
    );
  });

  test('uma referência é revertida no máximo uma vez', async () => {
    const wallet = await openWallet();
    const bet = await wager(wallet, { externalTransactionId: 'bet-1' });
    const processedReversal = (kind: string) =>
      insertTransaction(wallet, {
        kind,
        reference_external_transaction_id: 'bet-1',
        reference_transaction_id: bet.id,
        status: 'PROCESSED',
        processed_at: new Date(),
        observed_balance: '100',
        observed_currency: 'BRL',
      });
    await processedReversal('REFUND');
    await expectSqlState(processedReversal('ROLLBACK'), UNIQUE_VIOLATION, 'wager_transactions_one_reversal_uq');
  });

  test.each([
    ['outra carteira', 'wallet'],
    ['outro jogador', 'player'],
    ['outra rodada', 'round'],
  ])('referência precisa ser do mesmo provedor, jogador, carteira, moeda e rodada (%s)', async (_, field) => {
    const wallet = await openWallet();
    const other = await openWallet();
    const bet = await wager(wallet, { externalTransactionId: 'bet-1' });
    const target = field === 'wallet' ? other : wallet;
    await expectSqlState(
      insertTransaction(target, {
        kind: 'WIN',
        ...(field === 'player' && { player_id: 'outro' }),
        ...(field === 'round' && { round_id: 'round-2' }),
        reference_external_transaction_id: 'bet-1',
        reference_transaction_id: bet.id,
        status: 'PROCESSED',
        processed_at: new Date(),
        observed_balance: '100',
        observed_currency: 'BRL',
      }),
      FOREIGN_KEY_VIOLATION,
      'wager_transactions_reference_fk',
    );
  });

  test('PROCESSED com referência informada exige o vínculo', async () => {
    const wallet = await openWallet();
    await expectSqlState(
      insertTransaction(wallet, {
        kind: 'WIN',
        reference_external_transaction_id: 'bet-1',
        status: 'PROCESSED',
        processed_at: new Date(),
        observed_balance: '100',
        observed_currency: 'BRL',
      }),
      CHECK_VIOLATION,
      'wager_transactions_reference_linked_ck',
    );
  });
});

describe('wallet_ledger_entries', () => {
  test('é append-only: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const wallet = await openWallet();
    await wager(wallet);
    await expectSqlState(sql('update wallet_ledger_entries set amount = 1'), RAISED_EXCEPTION, 'append-only');
    await expectSqlState(sql('delete from wallet_ledger_entries'), RAISED_EXCEPTION, 'append-only');
    await expectSqlState(sql('truncate wallet_ledger_entries'), RAISED_EXCEPTION, 'append-only');
  });

  test('um único lançamento por transação e por versão da carteira', async () => {
    const wallet = await openWallet();
    const bet = await wager(wallet);
    await expectSqlState(insertEntry(wallet, bet.id), UNIQUE_VIOLATION, 'wallet_ledger_entries_transaction_uq');

    const win = await wager(wallet, { kind: 'WIN' });
    // Mesma versão de um lançamento existente: o sintoma de um lost update.
    const another = await insertTransaction(wallet, {
      kind: 'WIN',
      status: 'PROCESSED',
      processed_at: new Date(),
      observed_balance: '1',
      observed_currency: 'BRL',
    });
    await expectSqlState(
      insertEntry(wallet, another, { direction: 'CREDIT', balance_before: '90', balance_after: '100', wallet_version: 3 }),
      UNIQUE_VIOLATION,
      'wallet_ledger_entries_wallet_version_uq',
    );
    expect(win.status).toBe('PROCESSED');
  });

  test('aritmética fechada e saldos não negativos', async () => {
    const wallet = await openWallet();
    const processed = () =>
      insertTransaction(wallet, { status: 'PROCESSED', processed_at: new Date(), observed_balance: '1', observed_currency: 'BRL' });
    await expectSqlState(insertEntry(wallet, await processed(), { balance_after: '91' }), CHECK_VIOLATION, 'wallet_ledger_entries_balanced_ck');
    await expectSqlState(
      insertEntry(wallet, await processed(), { amount: '0', balance_after: '100' }),
      CHECK_VIOLATION,
      'wallet_ledger_entries_amount_positive_ck',
    );
    await expectSqlState(
      insertEntry(wallet, await processed(), { balance_before: '5', balance_after: '-5' }),
      CHECK_VIOLATION,
      'wallet_ledger_entries_balances_non_negative_ck',
    );
  });

  test('lançamento só para transação PROCESSED que move saldo', async () => {
    const wallet = await openWallet('1');
    const rejected = await wager(wallet, { money: { amount: '50', currency: 'BRL' } });
    expect(rejected.status).toBe('REJECTED');
    await expectSqlState(insertEntry(wallet, rejected.id), RAISED_EXCEPTION, 'exige transação PROCESSED');

    const loss = await wager(wallet, { kind: 'LOSS', money: { amount: '0', currency: 'BRL' } });
    await expectSqlState(insertEntry(wallet, loss.id), RAISED_EXCEPTION, 'exige transação PROCESSED');
  });

  test('lançamento tem a carteira e a moeda da transação', async () => {
    const wallet = await openWallet();
    const other = await openWallet();
    const id = await insertTransaction(wallet, {
      status: 'PROCESSED',
      processed_at: new Date(),
      observed_balance: '1',
      observed_currency: 'BRL',
    });
    await expectSqlState(insertEntry(other, id), FOREIGN_KEY_VIOLATION, 'wallet_ledger_entries_transaction_fk');
  });
});
