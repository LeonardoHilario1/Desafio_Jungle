import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/dominio/dinheiro';
import { Wallet } from '../../../src/dominio/carteira';
import { WalletLedgerEntry } from '../../../src/dominio/lancamento-ledger';
import { brl, errorCode } from '../../support/domain';

const open = (amount = '100.00') => Wallet.open({ playerId: 'player-1', initialBalance: brl(amount) });

describe('Wallet.open', () => {
  test('saldo zero: version 1, sem OPENING', () => {
    const { wallet, opening } = open('0');
    expect(wallet.balance.amount).toBe('0.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(opening).toBeNull();
  });

  test('saldo inicial: version 1, transação OPENING PROCESSED e lançamento CREDIT de 0 até o saldo', () => {
    const { wallet, opening } = open('1000.00');
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(opening!.transaction).toMatchObject({ kind: 'OPENING', walletId: wallet.id, providerId: 'internal' });
    expect(opening!.transaction.status).toBe('PROCESSED');
    expect(opening!.entry).toMatchObject({ direction: 'CREDIT', transactionId: opening!.transaction.id, walletVersion: 1 });
    expect(opening!.entry.balanceBefore.amount).toBe('0.00');
    expect(opening!.entry.balanceAfter.amount).toBe('1000.00');
  });

  test('playerId vazio é rejeitado', () => {
    expect(errorCode(() => Wallet.open({ playerId: '  ', initialBalance: brl('0') }))).toBe('INVALID_WALLET');
  });
});

describe('debit e credit', () => {
  test('debit muda saldo e version e devolve lançamento balanceado', () => {
    const { wallet } = open('100');
    const entry = wallet.debit(brl('30'), 'tx-1');
    expect(wallet.balance.amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(entry).toMatchObject({ direction: 'DEBIT', transactionId: 'tx-1', walletVersion: 2 });
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit soma e incrementa version', () => {
    const { wallet } = open('10');
    wallet.credit(brl('5.50'), 'tx-1');
    expect(wallet.balance.amount).toBe('15.50');
    expect(wallet.version).toBe(2);
  });

  test('saldo nunca fica negativo: débito acima do saldo lança e não altera nada', () => {
    const { wallet } = open('10');
    expect(wallet.canDebit(brl('10.01'))).toBe(false);
    expect(errorCode(() => wallet.debit(brl('10.01'), 'tx'))).toBe('INSUFFICIENT_FUNDS');
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('débito do saldo exato zera a carteira', () => {
    const { wallet } = open('10');
    wallet.debit(brl('10'), 'tx');
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('moeda diferente é rejeitada sem alterar a carteira', () => {
    const { wallet } = open('10');
    const usd = Money.from({ amount: '1', currency: 'USD' });
    expect(errorCode(() => wallet.credit(usd, 'tx'))).toBe('CURRENCY_MISMATCH');
    expect(errorCode(() => wallet.debit(usd, 'tx'))).toBe('CURRENCY_MISMATCH');
    expect(wallet.version).toBe(1);
  });

  test('valor zero não gera lançamento', () => {
    const { wallet } = open('10');
    expect(errorCode(() => wallet.credit(brl('0'), 'tx'))).toBe('INVALID_LEDGER_ENTRY');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('42'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toBe(at);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    walletId: 'w',
    transactionId: 't',
    direction: 'DEBIT' as const,
    money: brl('10'),
    balanceBefore: brl('50'),
    balanceAfter: brl('40'),
    walletVersion: 2,
  };

  test('create valida a aritmética do lançamento', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(errorCode(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('41') }))).toBe('INVALID_LEDGER_ENTRY');
    expect(errorCode(() => WalletLedgerEntry.create({ ...base, direction: 'CREDIT' }))).toBe('INVALID_LEDGER_ENTRY');
  });

  test('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'CREDIT';
    }).toThrow();
  });

  test('rejeita saldo negativo, valor zero e moedas misturadas', () => {
    expect(
      errorCode(() => WalletLedgerEntry.create({ ...base, balanceBefore: brl('5'), balanceAfter: brl('0').subtract(brl('5')) })),
    ).toBe('INVALID_LEDGER_ENTRY');
    expect(errorCode(() => WalletLedgerEntry.create({ ...base, money: brl('0'), balanceAfter: brl('50') }))).toBe(
      'INVALID_LEDGER_ENTRY',
    );
    expect(
      errorCode(() => WalletLedgerEntry.create({ ...base, money: Money.from({ amount: '10', currency: 'USD' }) })),
    ).toBe('CURRENCY_MISMATCH');
  });
});
