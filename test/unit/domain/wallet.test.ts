import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../src/domain/domain-error';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';

const brl = (amount: string) => Money.of(amount, 'BRL');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

function fundedWallet(amount: string): Wallet {
  const wallet = Wallet.open({ playerId: 'player-1', currency: 'BRL' });
  wallet.credit(brl(amount), 'tx-funding');
  return wallet;
}

describe('Wallet.open', () => {
  test('abre com saldo zero e version 1', () => {
    const wallet = Wallet.open({ playerId: 'player-1', currency: 'BRL' });
    expect(wallet.balance.equals(Money.zero('BRL'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
  });

  test('rejeita playerId vazio e moeda inválida', () => {
    expect(codeOf(() => Wallet.open({ playerId: '  ', currency: 'BRL' }))).toBe('INVALID_WALLET');
    expect(codeOf(() => Wallet.open({ playerId: 'p', currency: 'reais' }))).toBe('INVALID_CURRENCY');
  });
});

describe('debit e credit', () => {
  test('debit reduz o saldo, incrementa version e gera um lançamento', () => {
    const wallet = fundedWallet('100');
    const versionBefore = wallet.version;

    const entry = wallet.debit(brl('80'), 'tx-1');

    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(versionBefore + 1);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.amount.amount).toBe('80.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe('tx-1');
  });

  test('credit aumenta o saldo e gera um lançamento CREDIT', () => {
    const wallet = fundedWallet('10');
    const entry = wallet.credit(brl('5.25'), 'tx-2');
    expect(wallet.balance.amount).toBe('15.25');
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceAfter.amount).toBe('15.25');
  });

  test('debitar o saldo exato zera a carteira', () => {
    const wallet = fundedWallet('100');
    wallet.debit(brl('100'), 'tx-1');
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente lança INSUFFICIENT_FUNDS e não altera a carteira', () => {
    const wallet = fundedWallet('100');
    wallet.debit(brl('80'), 'tx-1');
    const version = wallet.version;

    expect(codeOf(() => wallet.debit(brl('80'), 'tx-2'))).toBe('INSUFFICIENT_FUNDS');
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(version);
  });

  test('moeda diferente da carteira lança CURRENCY_MISMATCH', () => {
    const wallet = fundedWallet('100');
    expect(codeOf(() => wallet.debit(Money.of('1', 'USD'), 'tx'))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => wallet.credit(Money.of('1', 'USD'), 'tx'))).toBe('CURRENCY_MISMATCH');
  });

  test('movimento de valor zero é rejeitado e não altera a carteira', () => {
    const wallet = fundedWallet('100');
    const version = wallet.version;
    expect(codeOf(() => wallet.credit(Money.zero('BRL'), 'tx'))).toBe('INVALID_AMOUNT');
    expect(wallet.version).toBe(version);
  });
});
