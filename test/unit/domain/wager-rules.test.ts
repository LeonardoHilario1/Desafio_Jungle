import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError } from '../../../src/domain/domain-error';
import { Money } from '../../../src/domain/money';
import { applyWager, type ReferenceContext } from '../../../src/domain/wager-rules';
import { WagerTransaction, type CreateWagerTransactionProps } from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { brl, txProps } from '../../support/domain';

let seq = 0;

function walletWith(amount: string): Wallet {
  return Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(amount) }).wallet;
}

function tx(kind: CreateWagerTransactionProps['kind'], amount: string, overrides: Partial<CreateWagerTransactionProps> = {}) {
  seq += 1;
  return WagerTransaction.create(
    txProps({ kind, money: brl(amount), externalTransactionId: `tx-${seq}`, idempotencyKey: `k-${seq}`, ...overrides }),
  );
}

const noReference: ReferenceContext = { reference: null, referenceAlreadyReversed: false };

/** Transação já aplicada à carteira (PROCESSED), para servir de referência. */
function processed(wallet: Wallet, kind: CreateWagerTransactionProps['kind'], amount: string, reference?: WagerTransaction) {
  const t = tx(kind, amount, reference ? { referenceExternalTransactionId: reference.externalTransactionId } : {});
  const outcome = applyWager(wallet, t, { reference: reference ?? null, referenceAlreadyReversed: false });
  expect(outcome.status).toBe('PROCESSED');
  return t;
}

const ref = (reference: WagerTransaction, referenceAlreadyReversed = false): ReferenceContext => ({
  reference,
  referenceAlreadyReversed,
});

describe('BET', () => {
  test('debita, gera 1 DEBIT e registra o saldo observado', () => {
    const wallet = walletWith('100');
    const bet = tx('BET', '25');
    const outcome = applyWager(wallet, bet, noReference);
    expect(outcome.status).toBe('PROCESSED');
    if (outcome.status !== 'PROCESSED') return;
    expect(outcome.entry!.direction).toBe('DEBIT');
    expect(wallet.balance.amount).toBe('75.00');
    expect(bet.observedBalance!.amount).toBe('75.00');
  });

  test('saldo insuficiente: REJECTED INSUFFICIENT_FUNDS, sem lançamento e sem mudar o saldo', () => {
    const wallet = walletWith('10');
    const bet = tx('BET', '10.01');
    expect(applyWager(wallet, bet, noReference)).toEqual({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(bet.observedBalance!.amount).toBe('10.00');
  });

  test('moeda diferente da carteira: REJECTED CURRENCY_MISMATCH', () => {
    const wallet = walletWith('100');
    const bet = tx('BET', '1', { money: Money.from({ amount: '1', currency: 'USD' }) });
    expect(applyWager(wallet, bet, noReference)).toMatchObject({ failureCode: 'CURRENCY_MISMATCH' });
  });

  test('jogador diferente do dono: REJECTED PLAYER_MISMATCH', () => {
    const wallet = walletWith('100');
    expect(applyWager(wallet, tx('BET', '1', { playerId: 'outro' }), noReference)).toMatchObject({
      failureCode: 'PLAYER_MISMATCH',
    });
  });
});

describe('WIN e LOSS', () => {
  test('WIN sem referência credita', () => {
    const wallet = walletWith('0');
    const outcome = applyWager(wallet, tx('WIN', '30'), noReference);
    expect(outcome).toMatchObject({ status: 'PROCESSED' });
    expect(wallet.balance.amount).toBe('30.00');
  });

  test('WIN referenciando a BET da rodada credita e vincula', () => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '10');
    const win = tx('WIN', '50', { referenceExternalTransactionId: bet.externalTransactionId });
    applyWager(wallet, win, ref(bet));
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe('140.00');
  });

  test('LOSS é processada sem mover saldo nem gerar lançamento', () => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '10');
    const loss = tx('LOSS', '10', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(applyWager(wallet, loss, ref(bet))).toEqual({ status: 'PROCESSED', entry: null });
    expect(wallet.balance.amount).toBe('90.00');
    expect(wallet.version).toBe(2);
  });

  test('WIN de outra rodada: REJECTED REFERENCE_MISMATCH', () => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '10');
    const win = tx('WIN', '5', { referenceExternalTransactionId: bet.externalTransactionId, roundId: 'round-2' });
    expect(applyWager(wallet, win, ref(bet))).toMatchObject({ failureCode: 'REFERENCE_MISMATCH' });
  });

  test('WIN referenciando outra WIN: REJECTED REFERENCE_KIND_NOT_ALLOWED', () => {
    const wallet = walletWith('100');
    const firstWin = processed(wallet, 'WIN', '10');
    const win = tx('WIN', '5', { referenceExternalTransactionId: firstWin.externalTransactionId });
    expect(applyWager(wallet, win, ref(firstWin))).toMatchObject({ failureCode: 'REFERENCE_KIND_NOT_ALLOWED' });
  });
});

describe('REFUND', () => {
  test('reverte uma BET PROCESSED: 1 CREDIT do mesmo valor', () => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '40');
    const refund = tx('REFUND', '40', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = applyWager(wallet, refund, ref(bet));
    expect(outcome).toMatchObject({ status: 'PROCESSED' });
    expect(wallet.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('só uma vez: segunda reversão é REJECTED REFERENCE_ALREADY_REVERSED', () => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '40');
    const refund = tx('REFUND', '40', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(applyWager(wallet, refund, ref(bet, true))).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(wallet.balance.amount).toBe('60.00');
  });

  test('só referencia BET', () => {
    const wallet = walletWith('100');
    const win = processed(wallet, 'WIN', '40');
    const refund = tx('REFUND', '40', { referenceExternalTransactionId: win.externalTransactionId });
    expect(applyWager(wallet, refund, ref(win))).toMatchObject({ failureCode: 'REFERENCE_KIND_NOT_ALLOWED' });
  });

  test('valor diferente da referência: REJECTED REFERENCE_AMOUNT_MISMATCH', () => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '40');
    const refund = tx('REFUND', '39.99', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(applyWager(wallet, refund, ref(bet))).toMatchObject({ failureCode: 'REFERENCE_AMOUNT_MISMATCH' });
  });

  test('referência REJECTED: REJECTED REFERENCE_NOT_PROCESSED', () => {
    const wallet = walletWith('1');
    const bet = tx('BET', '40');
    applyWager(wallet, bet, noReference);
    expect(bet.status).toBe('REJECTED');
    const refund = tx('REFUND', '40', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(applyWager(wallet, refund, ref(bet))).toMatchObject({ failureCode: 'REFERENCE_NOT_PROCESSED' });
  });

  test('referência de outro jogador ou carteira: REJECTED REFERENCE_MISMATCH', () => {
    const wallet = walletWith('100');
    const otherWallet = Wallet.open({ id: 'wallet-2', playerId: 'player-1', initialBalance: brl('100') }).wallet;
    const bet = tx('BET', '40', { walletId: 'wallet-2' });
    applyWager(otherWallet, bet, noReference);
    const refund = tx('REFUND', '40', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(applyWager(wallet, refund, ref(bet))).toMatchObject({ failureCode: 'REFERENCE_MISMATCH' });
  });
});

describe('ROLLBACK', () => {
  test('de BET credita', () => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '30');
    const rollback = tx('ROLLBACK', '30', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = applyWager(wallet, rollback, ref(bet));
    expect(outcome.status === 'PROCESSED' && outcome.entry!.direction).toBe('CREDIT');
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('de WIN debita', () => {
    const wallet = walletWith('100');
    const win = processed(wallet, 'WIN', '50');
    const rollback = tx('ROLLBACK', '50', { referenceExternalTransactionId: win.externalTransactionId });
    const outcome = applyWager(wallet, rollback, ref(win));
    expect(outcome.status === 'PROCESSED' && outcome.entry!.direction).toBe('DEBIT');
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('de REFUND debita', () => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '20');
    const refund = processed(wallet, 'REFUND', '20', bet);
    const rollback = tx('ROLLBACK', '20', { referenceExternalTransactionId: refund.externalTransactionId });
    applyWager(wallet, rollback, ref(refund));
    expect(wallet.balance.amount).toBe('80.00');
  });

  test('que deixaria saldo negativo: REJECTED REVERSAL_INSUFFICIENT_FUNDS, distinto de INSUFFICIENT_FUNDS', () => {
    const wallet = walletWith('0');
    const win = processed(wallet, 'WIN', '50');
    processed(wallet, 'BET', '45');
    const rollback = tx('ROLLBACK', '50', { referenceExternalTransactionId: win.externalTransactionId });
    expect(applyWager(wallet, rollback, ref(win))).toEqual({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
    });
    expect(wallet.balance.amount).toBe('5.00');
  });

  test.each(['LOSS', 'ROLLBACK'] as const)('não referencia %s', (kind) => {
    const wallet = walletWith('100');
    const bet = processed(wallet, 'BET', '10');
    const target = kind === 'LOSS' ? processed(wallet, 'LOSS', '10', bet) : processed(wallet, 'ROLLBACK', '10', bet);
    const rollback = tx('ROLLBACK', '10', { referenceExternalTransactionId: target.externalTransactionId });
    expect(applyWager(wallet, rollback, ref(target))).toMatchObject({ failureCode: 'REFERENCE_KIND_NOT_ALLOWED' });
  });
});

describe('referência fora de ordem', () => {
  test('referência ausente: PENDING_REFERENCE, sem efeito no saldo', () => {
    const wallet = walletWith('100');
    const refund = tx('REFUND', '10', { referenceExternalTransactionId: 'ainda-nao-chegou' });
    expect(applyWager(wallet, refund, noReference)).toEqual({ status: 'PENDING_REFERENCE' });
    expect(refund.status).toBe('PENDING_REFERENCE');
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('reprocessada quando a referência chega: PENDING_REFERENCE → PROCESSED', () => {
    const wallet = walletWith('100');
    const refund = tx('REFUND', '10', { referenceExternalTransactionId: 'bet-tardia' });
    applyWager(wallet, refund, noReference);
    // Segunda tentativa ainda sem referência: continua aguardando, sem erro.
    expect(applyWager(wallet, refund, noReference)).toEqual({ status: 'PENDING_REFERENCE' });

    const bet = tx('BET', '10', { externalTransactionId: 'bet-tardia' });
    applyWager(wallet, bet, noReference);
    expect(applyWager(wallet, refund, ref(bet))).toMatchObject({ status: 'PROCESSED' });
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('referência ainda aberta (PENDING_REFERENCE) também aguarda', () => {
    const wallet = walletWith('100');
    const pendingRefund = tx('REFUND', '10', { referenceExternalTransactionId: 'x' });
    applyWager(wallet, pendingRefund, noReference);
    const rollback = tx('ROLLBACK', '10', { referenceExternalTransactionId: pendingRefund.externalTransactionId });
    expect(applyWager(wallet, rollback, ref(pendingRefund))).toEqual({ status: 'PENDING_REFERENCE' });
  });
});

test('transação terminal não é reaplicada', () => {
  const wallet = walletWith('100');
  const bet = processed(wallet, 'BET', '10');
  expect(() => applyWager(wallet, bet, noReference)).toThrow(InvalidTransactionStateError);
});
