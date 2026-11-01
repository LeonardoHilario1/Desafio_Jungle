import { InvalidTransactionStateError, type FailureCode } from './domain-error';
import type { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

/** O que o caso de uso leu do banco, com o lock da carteira na mão, para decidir. */
export interface ReferenceContext {
  /** Transação resolvida por (providerId, referenceExternalTransactionId); null se não existe. */
  reference: WagerTransaction | null;
  /** Já existe reversão PROCESSED da referência. */
  referenceAlreadyReversed: boolean;
}

export type WagerOutcome =
  | { status: 'PROCESSED'; entry: WalletLedgerEntry | null }
  | { status: 'REJECTED'; failureCode: FailureCode }
  | { status: 'PENDING_REFERENCE' };

// Tipos de referência aceitos por kind.
const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  WIN: ['BET'],
  LOSS: ['BET'],
  REFUND: ['BET'],
  ROLLBACK: ['BET', 'WIN', 'REFUND'],
};

/**
 * Aplica uma transação aberta (PENDING ou PENDING_REFERENCE) à carteira: decide entre
 * processar, rejeitar ou aguardar a referência, e executa a transição. Puro: não faz
 * I/O; quem chama garante que a carteira está travada e grava o resultado.
 *
 * Ordem das verificações:
 * 1. moeda e jogador da operação contra a carteira;
 * 2. referência: ausente ou ainda aberta → aguarda; caso contrário precisa estar
 *    PROCESSED, ser do mesmo jogador, carteira, moeda e rodada, e de um tipo permitido;
 * 3. reversões: mesmo valor da referência e nenhuma reversão anterior da mesma referência;
 * 4. efeito no saldo: débito sem saldo é rejeitado (INSUFFICIENT_FUNDS para BET,
 *    REVERSAL_INSUFFICIENT_FUNDS para ROLLBACK).
 */
export function applyWager(
  wallet: Wallet,
  tx: WagerTransaction,
  ctx: ReferenceContext,
  at: Date = new Date(),
): WagerOutcome {
  if (tx.isTerminal()) {
    throw new InvalidTransactionStateError(`Transação ${tx.id} já está em ${tx.status}`);
  }
  if (tx.walletId !== wallet.id) {
    throw new InvalidTransactionStateError('Transação aplicada à carteira errada');
  }

  const reject = (failureCode: FailureCode): WagerOutcome => {
    tx.reject(failureCode, wallet.balance, at);
    return { status: 'REJECTED', failureCode };
  };

  if (tx.money.currency !== wallet.currency) return reject('CURRENCY_MISMATCH');
  if (tx.playerId !== wallet.playerId) return reject('PLAYER_MISMATCH');

  const reference = ctx.reference;
  if (tx.referenceExternalTransactionId !== null) {
    if (reference === null || !reference.isTerminal()) {
      // Entrega fora de ordem: a referência ainda não chegou ou ainda não terminou.
      if (tx.status === 'PENDING') tx.markPendingReference(wallet.balance);
      return { status: 'PENDING_REFERENCE' };
    }
    if (
      reference.providerId !== tx.providerId ||
      reference.externalTransactionId !== tx.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionStateError('Referência informada não é a referenciada');
    }
    if (reference.status !== 'PROCESSED') return reject('REFERENCE_NOT_PROCESSED');
    if (
      reference.walletId !== tx.walletId ||
      reference.playerId !== tx.playerId ||
      reference.money.currency !== tx.money.currency ||
      reference.roundId !== tx.roundId
    ) {
      return reject('REFERENCE_MISMATCH');
    }
    if (!ALLOWED_REFERENCES[tx.kind]?.includes(reference.kind)) return reject('REFERENCE_KIND_NOT_ALLOWED');
    if (tx.isReversal()) {
      if (!tx.money.equals(reference.money)) return reject('REFERENCE_AMOUNT_MISMATCH');
      if (ctx.referenceAlreadyReversed) return reject('REFERENCE_ALREADY_REVERSED');
    }
  }

  let entry: WalletLedgerEntry | null = null;
  if (tx.affectsBalance()) {
    const direction = tx.ledgerDirectionFor(reference ?? undefined);
    if (direction === 'DEBIT') {
      if (!wallet.canDebit(tx.money)) return reject(tx.isReversal() ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
      entry = wallet.debit(tx.money, tx.id, at);
    } else {
      entry = wallet.credit(tx.money, tx.id, at);
    }
  }
  tx.markProcessed(reference?.id ?? null, wallet.balance, at);
  return { status: 'PROCESSED', entry };
}
