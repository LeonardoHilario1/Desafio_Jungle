import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { expectSqlState, initTestOrm, resetDatabase } from '../support/database';

// SQLSTATEs do PostgreSQL usados nas asserções.
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RAISED_EXCEPTION = 'P0001';

let orm: MikroORM;

beforeAll(async () => {
  orm = await initTestOrm();
});

beforeEach(async () => {
  await resetDatabase(orm);
});

afterAll(async () => {
  await orm.close(true);
});

const sql = (query: string, params: unknown[] = []) => orm.em.getConnection().execute(query, params);

async function save(...entities: object[]): Promise<void> {
  const em = orm.em.fork();
  em.persist(entities);
  await em.flush();
}

/** Carteira com saldo, BET processada e o lançamento de débito, gravados pelo ORM. */
async function walletWithProcessedBet(initial = '100', betAmount = '30') {
  const em = orm.em.fork();
  const wallet = Wallet.open({ playerId: `player-${crypto.randomUUID()}`, currency: 'BRL' });
  // Saldo inicial direto pelo domínio, sem lançamento gravado: aqui só importa o schema.
  wallet.credit(Money.of(initial, 'BRL'), crypto.randomUUID());
  await em.persist(wallet).flush();

  const bet = WagerTransaction.receive({
    idempotencyKey: `bet-${crypto.randomUUID()}`,
    walletId: wallet.id,
    type: 'BET',
    amount: Money.of(betAmount, 'BRL'),
    referenceKey: null,
  });
  const entry = wallet.debit(bet.amount(), bet.id);
  bet.markProcessed();
  // Um flush por entidade, na ordem das FKs (o mapeamento não declara relações).
  await em.persist(bet).flush();
  await em.persist(entry).flush();
  return { wallet, bet, entry };
}

describe('mapeamento ORM', () => {
  test('grava e relê as entidades com Money em string e version', async () => {
    const { wallet, bet, entry } = await walletWithProcessedBet('100', '80');

    const em = orm.em.fork();
    const loadedWallet = await em.findOneOrFail(Wallet, { id: wallet.id });
    const loadedBet = await em.findOneOrFail(WagerTransaction, { id: bet.id });
    const loadedEntry = await em.findOneOrFail(WalletLedgerEntry, { id: entry.id });

    expect(loadedWallet).toBeInstanceOf(Wallet);
    expect(loadedWallet.balance().equals(Money.of('20', 'BRL'))).toBe(true);
    expect(loadedWallet.version()).toBe(3);

    expect(loadedBet).toBeInstanceOf(WagerTransaction);
    expect(loadedBet.status()).toBe('PROCESSED');
    expect(loadedBet.amount().amount).toBe('80.00');
    expect(loadedBet.payloadHash).toBe(bet.payloadHash);

    expect(loadedEntry.direction).toBe('DEBIT');
    expect(loadedEntry.amount().amount).toBe('80.00');
    expect(loadedEntry.balanceAfter().amount).toBe('20.00');

    // O driver devolve numeric como string; nada passa por number.
    const [raw] = await sql('select balance from wallets where id = ?', [wallet.id]);
    expect(raw).toEqual({ balance: '20.00' });
  });

  test('alteração de saldo pelo ORM grava balance e version', async () => {
    const { wallet } = await walletWithProcessedBet('100', '30');
    const em = orm.em.fork();
    const loaded = await em.findOneOrFail(Wallet, { id: wallet.id });
    const before = loaded.version();
    loaded.credit(Money.of('5', 'BRL'), crypto.randomUUID());
    await em.flush();

    const [raw] = await sql('select balance, version from wallets where id = ?', [wallet.id]);
    expect(raw).toEqual({ balance: '75.00', version: before + 1 });
  });
});

describe('wallets', () => {
  test('uma carteira por jogador e moeda', async () => {
    await save(Wallet.open({ playerId: 'p1', currency: 'BRL' }));
    await save(Wallet.open({ playerId: 'p1', currency: 'USD' }));
    await expectSqlState(save(Wallet.open({ playerId: 'p1', currency: 'BRL' })), UNIQUE_VIOLATION, 'wallets_player_currency_uq');
  });

  test('saldo não pode ficar negativo', async () => {
    const { wallet } = await walletWithProcessedBet();
    await expectSqlState(
      sql('update wallets set balance = -0.01 where id = ?', [wallet.id]),
      CHECK_VIOLATION,
      'wallets_balance_non_negative_ck',
    );
  });

  test('moeda precisa ser ISO de 3 letras', async () => {
    await expectSqlState(
      sql(`insert into wallets (id, player_id, currency) values (gen_random_uuid(), 'p', 'br1')`),
      CHECK_VIOLATION,
      'wallets_currency_ck',
    );
  });
});

describe('wager_transactions', () => {
  test('idempotency_key é única', async () => {
    const { wallet, bet } = await walletWithProcessedBet();
    const duplicate = WagerTransaction.receive({
      idempotencyKey: bet.idempotencyKey,
      walletId: wallet.id,
      type: 'BET',
      amount: Money.of('1', 'BRL'),
      referenceKey: null,
    });
    await expectSqlState(save(duplicate), UNIQUE_VIOLATION, 'wager_transactions_idempotency_key_uq');
  });

  test('moeda da transação precisa ser a da carteira', async () => {
    const { wallet } = await walletWithProcessedBet();
    const usd = WagerTransaction.receive({
      idempotencyKey: 'usd-bet',
      walletId: wallet.id,
      type: 'BET',
      amount: Money.of('1', 'USD'),
      referenceKey: null,
    });
    await expectSqlState(save(usd), FOREIGN_KEY_VIOLATION, 'wager_transactions_wallet_currency_fk');
  });

  test('forma por tipo é validada no banco', async () => {
    const { wallet } = await walletWithProcessedBet();
    await expectSqlState(
      sql(
        `insert into wager_transactions (id, idempotency_key, payload_hash, wallet_id, type, currency, amount, reference_key, status)
         values (gen_random_uuid(), 'x', repeat('a', 64), ?, 'BET', 'BRL', 10, 'ref', 'PENDING')`,
        [wallet.id],
      ),
      CHECK_VIOLATION,
      'wager_transactions_shape_ck',
    );
  });

  test('REJECTED exige failure_code', async () => {
    const { wallet } = await walletWithProcessedBet();
    await expectSqlState(
      sql(
        `insert into wager_transactions (id, idempotency_key, payload_hash, wallet_id, type, currency, amount, status, processed_at)
         values (gen_random_uuid(), 'x', repeat('a', 64), ?, 'BET', 'BRL', 10, 'REJECTED', now())`,
        [wallet.id],
      ),
      CHECK_VIOLATION,
      'wager_transactions_failure_code_ck',
    );
  });

  test('estado terminal não muda', async () => {
    const { bet } = await walletWithProcessedBet();
    await expectSqlState(
      sql(`update wager_transactions set status = 'FAILED', failure_code = 'INTERNAL_ERROR' where id = ?`, [bet.id]),
      RAISED_EXCEPTION,
      'estado terminal',
    );
  });

  test('campos de negócio são imutáveis mesmo em estado aberto', async () => {
    const { wallet } = await walletWithProcessedBet();
    const pending = WagerTransaction.receive({
      idempotencyKey: 'pending-bet',
      walletId: wallet.id,
      type: 'BET',
      amount: Money.of('1', 'BRL'),
      referenceKey: null,
    });
    await save(pending);
    await expectSqlState(
      sql('update wager_transactions set amount = 2 where id = ?', [pending.id]),
      RAISED_EXCEPTION,
      'imutáveis',
    );
    // Transição de estado em transação aberta continua permitida.
    await sql(`update wager_transactions set status = 'PROCESSED', processed_at = now() where id = ?`, [pending.id]);
  });

  test('não permite DELETE nem TRUNCATE', async () => {
    const { bet } = await walletWithProcessedBet();
    await expectSqlState(sql('delete from wager_transactions where id = ?', [bet.id]), RAISED_EXCEPTION);
    await expectSqlState(sql('truncate wager_transactions cascade'), RAISED_EXCEPTION);
  });

  test('uma BET só é liquidada uma vez', async () => {
    const { wallet, bet } = await walletWithProcessedBet();
    const settle = (key: string, type: 'WIN' | 'LOSS', amount: string) => {
      const tx = WagerTransaction.receive({
        idempotencyKey: key,
        walletId: wallet.id,
        type,
        amount: Money.of(amount, 'BRL'),
        referenceKey: bet.idempotencyKey,
      });
      expect(tx.linkReference(bet)).toBeNull();
      tx.markProcessed();
      return tx;
    };

    await save(settle('win-1', 'WIN', '50'));
    await expectSqlState(save(settle('loss-1', 'LOSS', '0')), UNIQUE_VIOLATION, 'wager_transactions_one_settlement_per_bet_uq');
  });

  test('BET liquidada precisa ser da mesma carteira', async () => {
    const { bet } = await walletWithProcessedBet();
    const { wallet: other } = await walletWithProcessedBet();
    await expectSqlState(
      sql(
        `insert into wager_transactions (id, idempotency_key, payload_hash, wallet_id, type, currency, amount,
                                         reference_key, reference_transaction_id, status, processed_at)
         values (gen_random_uuid(), 'cross', repeat('a', 64), ?, 'WIN', 'BRL', 10, ?, ?, 'PROCESSED', now())`,
        [other.id, bet.idempotencyKey, bet.id],
      ),
      FOREIGN_KEY_VIOLATION,
      'wager_transactions_reference_fk',
    );
  });
});

describe('wallet_ledger_entries', () => {
  test('é append-only: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const { entry } = await walletWithProcessedBet();
    await expectSqlState(sql('update wallet_ledger_entries set amount = 1 where id = ?', [entry.id]), RAISED_EXCEPTION, 'append-only');
    await expectSqlState(sql('delete from wallet_ledger_entries where id = ?', [entry.id]), RAISED_EXCEPTION, 'append-only');
    await expectSqlState(sql('truncate wallet_ledger_entries'), RAISED_EXCEPTION, 'append-only');

    const [row] = await sql('select amount from wallet_ledger_entries where id = ?', [entry.id]);
    expect(row).toEqual({ amount: '30.00' });
  });

  test('um único lançamento por transação', async () => {
    const { wallet, bet } = await walletWithProcessedBet();
    await expectSqlState(
      sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_after)
         values (gen_random_uuid(), ?, ?, 'DEBIT', 'BRL', 30, 40)`,
        [wallet.id, bet.id],
      ),
      UNIQUE_VIOLATION,
      'wallet_ledger_entries_transaction_uq',
    );
  });

  test('lançamento precisa ser da mesma carteira da transação', async () => {
    const { wallet } = await walletWithProcessedBet();
    const { wallet: other } = await walletWithProcessedBet();
    const pending = WagerTransaction.receive({
      idempotencyKey: 'sem-lancamento',
      walletId: wallet.id,
      type: 'BET',
      amount: Money.of('1', 'BRL'),
      referenceKey: null,
    });
    await save(pending);
    await expectSqlState(
      sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_after)
         values (gen_random_uuid(), ?, ?, 'DEBIT', 'BRL', 1, 1)`,
        [other.id, pending.id],
      ),
      FOREIGN_KEY_VIOLATION,
      'wallet_ledger_entries_transaction_wallet_fk',
    );
  });

  test('valor positivo e saldo resultante não negativo', async () => {
    const { wallet } = await walletWithProcessedBet();
    const pending = WagerTransaction.receive({
      idempotencyKey: 'p',
      walletId: wallet.id,
      type: 'BET',
      amount: Money.of('1', 'BRL'),
      referenceKey: null,
    });
    await save(pending);
    const insert = (amount: string, balanceAfter: string) =>
      sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, amount, balance_after)
         values (gen_random_uuid(), ?, ?, 'DEBIT', 'BRL', ?::numeric, ?::numeric)`,
        [wallet.id, pending.id, amount, balanceAfter],
      );
    await expectSqlState(insert('0', '10'), CHECK_VIOLATION, 'wallet_ledger_entries_amount_positive_ck');
    await expectSqlState(insert('1', '-1'), CHECK_VIOLATION, 'wallet_ledger_entries_balance_after_non_negative_ck');
  });
});
