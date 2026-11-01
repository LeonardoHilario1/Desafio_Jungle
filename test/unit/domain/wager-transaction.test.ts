import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError } from '../../../src/dominio/erro-dominio';
import { Money } from '../../../src/dominio/dinheiro';
import { WagerTransaction, type CreateWagerTransactionProps } from '../../../src/dominio/transacao-aposta';
import { brl, errorCode, txProps as props } from '../../support/domain';


describe('WagerTransaction.create', () => {
  test('nasce PENDING com os campos de negócio', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe('PENDING');
    expect(tx).toMatchObject({ providerId: 'provider-a', externalTransactionId: 'tx-1', kind: 'BET' });
    expect(tx.money.amount).toBe('10.00');
    expect(tx.referenceTransactionId).toBeNull();
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ['BET com referência', { kind: 'BET', referenceExternalTransactionId: 'bet-0' }],
    ['BET de valor zero', { kind: 'BET', money: brl('0') }],
    ['WIN de valor zero', { kind: 'WIN', money: brl('0') }],
    ['REFUND sem referência', { kind: 'REFUND' }],
    ['ROLLBACK sem referência', { kind: 'ROLLBACK' }],
    ['REFUND de valor zero', { kind: 'REFUND', money: brl('0'), referenceExternalTransactionId: 'bet-0' }],
    ['referência a si mesma', { kind: 'WIN', referenceExternalTransactionId: 'tx-1' }],
    ['OPENING pela API', { kind: 'OPENING' }],
    ['kind desconhecido', { kind: 'JACKPOT' }],
    ['providerId vazio', { providerId: '' }],
    ['roundId vazio', { roundId: ' ' }],
    ['gameId longo demais', { gameId: 'g'.repeat(256) }],
  ] as const)('rejeita %s', (_, overrides) => {
    expect(errorCode(() => WagerTransaction.create(props(overrides as Partial<CreateWagerTransactionProps>)))).toBe(
      'INVALID_TRANSACTION',
    );
  });

  test.each([
    ['WIN sem referência', { kind: 'WIN' }],
    ['WIN com referência', { kind: 'WIN', referenceExternalTransactionId: 'bet-0' }],
    ['LOSS de valor zero', { kind: 'LOSS', money: brl('0') }],
    ['LOSS com valor', { kind: 'LOSS', money: brl('10'), referenceExternalTransactionId: 'bet-0' }],
    ['REFUND', { kind: 'REFUND', referenceExternalTransactionId: 'bet-0' }],
    ['ROLLBACK', { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-0' }],
  ] as const)('aceita %s', (_, overrides) => {
    expect(WagerTransaction.create(props(overrides as Partial<CreateWagerTransactionProps>)).status).toBe('PENDING');
  });
});

describe('payloadHash', () => {
  test('não depende da Idempotency-Key, do correlationId nem da forma do valor', () => {
    const a = WagerTransaction.create(props({ money: brl('10') }));
    const b = WagerTransaction.create(props({ money: brl('10.00'), idempotencyKey: 'outra', correlationId: 'c' }));
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.matchesPayload(b.payloadHash)).toBe(true);
  });

  test.each([
    ['valor', { money: brl('10.01') }],
    ['moeda', { money: Money.from({ amount: '10', currency: 'USD' }) }],
    ['kind', { kind: 'WIN' }],
    ['carteira', { walletId: 'wallet-2' }],
    ['jogador', { playerId: 'player-2' }],
    ['rodada', { roundId: 'round-2' }],
    ['jogo', { gameId: 'game-2' }],
    ['provedor', { providerId: 'provider-b' }],
    ['id externo', { externalTransactionId: 'tx-2' }],
  ] as const)('muda quando muda %s', (_, overrides) => {
    const base = WagerTransaction.create(props());
    const changed = WagerTransaction.create(props(overrides as Partial<CreateWagerTransactionProps>));
    expect(changed.matchesPayload(base.payloadHash)).toBe(false);
  });
});

describe('transições', () => {
  test('PENDING → PROCESSED registra saldo observado e momento', () => {
    const tx = WagerTransaction.create(props());
    const at = new Date('2026-01-01T00:00:00Z');
    tx.markProcessed(null, brl('90'), at);
    expect(tx.status).toBe('PROCESSED');
    expect(tx.observedBalance!.amount).toBe('90.00');
    expect(tx.processedAt).toBe(at);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED, com vínculo à referência', () => {
    const tx = WagerTransaction.create(props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-0' }));
    tx.markPendingReference(brl('100'));
    expect(tx.status).toBe('PENDING_REFERENCE');
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('bet-id', brl('110'));
    expect(tx.referenceTransactionId).toBe('bet-id');
  });

  test('reject e fail gravam o código', () => {
    const rejected = WagerTransaction.create(props());
    rejected.reject('INSUFFICIENT_FUNDS', brl('5'));
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');

    const failed = WagerTransaction.create(props());
    failed.fail('PROCESSING_FAILED');
    expect(failed.status).toBe('FAILED');
    expect(failed.failureCode).toBe('PROCESSING_FAILED');
  });

  test.each(['markProcessed', 'reject', 'fail', 'markPendingReference'] as const)(
    'estado terminal não muda: %s lança InvalidTransactionStateError',
    (method) => {
      const tx = WagerTransaction.create(props({ kind: 'WIN', referenceExternalTransactionId: 'bet-0' }));
      tx.markProcessed('bet-id', brl('1'));
      const call = {
        markProcessed: () => tx.markProcessed('bet-id', brl('1')),
        reject: () => tx.reject('INSUFFICIENT_FUNDS', brl('1')),
        fail: () => tx.fail('PROCESSING_FAILED'),
        markPendingReference: () => tx.markPendingReference(brl('1')),
      }[method];
      expect(call).toThrow(InvalidTransactionStateError);
    },
  );

  test('vínculo de referência precisa ser coerente com a transação', () => {
    const withRef = WagerTransaction.create(props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-0' }));
    expect(() => withRef.markProcessed(null, brl('1'))).toThrow(InvalidTransactionStateError);
    const withoutRef = WagerTransaction.create(props());
    expect(() => withoutRef.markProcessed('x', brl('1'))).toThrow(InvalidTransactionStateError);
    expect(() => withoutRef.markPendingReference(brl('1'))).toThrow(InvalidTransactionStateError);
  });
});

describe('consultas de domínio', () => {
  test('affectsBalance, requiresReference e direção do lançamento', () => {
    const bet = WagerTransaction.create(props());
    const win = WagerTransaction.create(props({ kind: 'WIN' }));
    const loss = WagerTransaction.create(props({ kind: 'LOSS' }));
    const refund = WagerTransaction.create(props({ kind: 'REFUND', referenceExternalTransactionId: 'bet-0' }));
    const rollback = WagerTransaction.create(props({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-0' }));

    expect(loss.affectsBalance()).toBe(false);
    expect([bet, win, refund, rollback].every((t) => t.affectsBalance())).toBe(true);
    expect([refund, rollback].every((t) => t.requiresReference())).toBe(true);
    expect([bet, win, loss].some((t) => t.requiresReference())).toBe(false);

    expect(bet.ledgerDirectionFor()).toBe('DEBIT');
    expect(win.ledgerDirectionFor()).toBe('CREDIT');
    expect(refund.ledgerDirectionFor()).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
    expect(rollback.ledgerDirectionFor(refund)).toBe('DEBIT');
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate reconstrói sem revalidar a forma', () => {
    const original = WagerTransaction.create(props());
    original.reject('INSUFFICIENT_FUNDS', brl('1'));
    const copy = WagerTransaction.rehydrate({
      ...original,
      status: original.status,
      referenceTransactionId: original.referenceTransactionId,
      failureCode: original.failureCode,
      processedAt: original.processedAt,
      observedBalance: original.observedBalance,
    });
    expect(copy.status).toBe('REJECTED');
    expect(copy.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(copy.payloadHash).toBe(original.payloadHash);
  });
});
