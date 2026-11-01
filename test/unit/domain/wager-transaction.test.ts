import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../src/domain/domain-error';
import { Money } from '../../../src/domain/money';
import { canonicalJson } from '../../../src/domain/payload-hash';
import { WagerTransaction, type ReceiveTransactionParams } from '../../../src/domain/wager-transaction';

const brl = (amount: string) => Money.of(amount, 'BRL');

function bet(overrides: Partial<ReceiveTransactionParams> = {}): WagerTransaction {
  return WagerTransaction.receive({
    idempotencyKey: 'bet-1',
    walletId: 'wallet-1',
    type: 'BET',
    amount: brl('10'),
    referenceKey: null,
    ...overrides,
  });
}

function win(overrides: Partial<ReceiveTransactionParams> = {}): WagerTransaction {
  return WagerTransaction.receive({
    idempotencyKey: 'win-1',
    walletId: 'wallet-1',
    type: 'WIN',
    amount: brl('25'),
    referenceKey: 'bet-1',
    ...overrides,
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

describe('WagerTransaction.receive', () => {
  test('nasce PENDING, sem failureCode', () => {
    const tx = bet();
    expect(tx.status).toBe('PENDING');
    expect(tx.failureCode).toBeNull();
    expect(tx.isTerminal()).toBe(false);
  });

  test.each<[string, Partial<ReceiveTransactionParams>]>([
    ['BET com referência', { type: 'BET', referenceKey: 'x' }],
    ['BET com valor zero', { type: 'BET', amount: brl('0') }],
    ['WIN sem referência', { type: 'WIN', referenceKey: null }],
    ['WIN com valor zero', { type: 'WIN', referenceKey: 'bet-1', amount: brl('0') }],
    ['LOSS sem referência', { type: 'LOSS', referenceKey: null, amount: brl('0') }],
    ['LOSS com valor', { type: 'LOSS', referenceKey: 'bet-1', amount: brl('1') }],
    ['tipo desconhecido', { type: 'REFUND' as never }],
    ['idempotencyKey vazia', { idempotencyKey: '' }],
    ['idempotencyKey longa demais', { idempotencyKey: 'k'.repeat(256) }],
    ['walletId vazio', { walletId: ' ' }],
  ])('rejeita %s', (_, overrides) => {
    expect(codeOf(() => bet(overrides))).toBe('INVALID_TRANSACTION');
  });

  test('aceita LOSS com valor zero e referência', () => {
    const loss = bet({ idempotencyKey: 'loss-1', type: 'LOSS', amount: brl('0'), referenceKey: 'bet-1' });
    expect(loss.type).toBe('LOSS');
  });
});

describe('payloadHash', () => {
  test('não depende da chave de idempotência nem da forma do valor', () => {
    const a = bet({ idempotencyKey: 'a', amount: brl('10') });
    const b = bet({ idempotencyKey: 'b', amount: brl('10.00') });
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('muda quando muda um campo de negócio', () => {
    const base = bet().payloadHash;
    expect(bet({ amount: brl('10.01') }).payloadHash).not.toBe(base);
    expect(bet({ amount: Money.of('10', 'USD') }).payloadHash).not.toBe(base);
    expect(bet({ walletId: 'wallet-2' }).payloadHash).not.toBe(base);
  });

  test('JSON canônico ordena as chaves', () => {
    expect(canonicalJson({ b: '1', a: { d: null, c: '2' } })).toBe('{"a":{"c":"2","d":null},"b":"1"}');
  });
});

describe('transições de estado', () => {
  test('BET vai de PENDING para PROCESSED', () => {
    const tx = bet();
    tx.markProcessed();
    expect(tx.status).toBe('PROCESSED');
    expect(tx.processedAt).toBeInstanceOf(Date);
    expect(tx.isTerminal()).toBe(true);
  });

  test('reject e fail guardam o failureCode', () => {
    const rejected = bet();
    rejected.reject('INSUFFICIENT_FUNDS');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');

    const failed = bet();
    failed.fail('INTERNAL_ERROR');
    expect(failed.status).toBe('FAILED');
    expect(failed.failureCode).toBe('INTERNAL_ERROR');
  });

  test.each(['markProcessed', 'reject', 'fail'] as const)('estado terminal não aceita %s', (method) => {
    const tx = bet();
    tx.reject('INSUFFICIENT_FUNDS');
    expect(codeOf(() => (method === 'markProcessed' ? tx.markProcessed() : tx[method]('INTERNAL_ERROR')))).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(tx.status).toBe('REJECTED');
  });

  test('WIN aguarda referência e depois é processada', () => {
    const w = win();
    w.awaitReference();
    expect(w.status).toBe('PENDING_REFERENCE');

    const b = bet();
    b.markProcessed();
    expect(w.linkReference(b)).toBeNull();
    expect(w.referenceTransactionId).toBe(b.id);
    w.markProcessed();
    expect(w.status).toBe('PROCESSED');
  });

  test('BET não pode aguardar referência', () => {
    expect(codeOf(() => bet().awaitReference())).toBe('INVALID_STATE_TRANSITION');
  });

  test('WIN não é processada sem vínculo com a BET', () => {
    expect(codeOf(() => win().markProcessed())).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('linkReference', () => {
  function processedBet(overrides: Partial<ReceiveTransactionParams> = {}): WagerTransaction {
    const b = bet(overrides);
    b.markProcessed();
    return b;
  }

  test('rejeita BET de outra carteira', () => {
    expect(win().linkReference(processedBet({ walletId: 'wallet-2' }))).toBe('REFERENCE_WALLET_MISMATCH');
  });

  test('rejeita BET em outra moeda', () => {
    expect(win().linkReference(processedBet({ amount: Money.of('10', 'USD') }))).toBe('CURRENCY_MISMATCH');
  });

  test('rejeita BET que não foi processada', () => {
    const rejectedBet = bet();
    rejectedBet.reject('INSUFFICIENT_FUNDS');
    expect(win().linkReference(rejectedBet)).toBe('REFERENCE_NOT_PROCESSED');
  });

  test('rejeita referência que não é BET', () => {
    const otherWin = win({ idempotencyKey: 'bet-1', referenceKey: 'x' });
    expect(win().linkReference(otherWin)).toBe('REFERENCE_NOT_A_BET');
  });

  test('a transação informada precisa ser a referenciada', () => {
    expect(codeOf(() => win().linkReference(processedBet({ idempotencyKey: 'outra' })))).toBe('INVALID_TRANSACTION');
  });
});
