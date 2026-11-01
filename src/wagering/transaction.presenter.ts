import type { FailureCode } from '../domain/domain-error';
import type { TransactionStatus, WagerTransaction, WagerType } from '../domain/wager-transaction';

export interface TransactionView {
  id: string;
  idempotencyKey: string;
  walletId: string;
  type: WagerType;
  amount: string;
  currency: string;
  referenceKey: string | null;
  status: TransactionStatus;
  failureCode: FailureCode | null;
  createdAt: string;
  processedAt: string | null;
}

export function presentTransaction(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    type: tx.type,
    amount: tx.amount().amount,
    currency: tx.currency,
    referenceKey: tx.referenceKey,
    status: tx.status(),
    failureCode: tx.failureCode(),
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt()?.toISOString() ?? null,
  };
}

/**
 * Status HTTP derivado só do estado gravado, para que o replay devolva exatamente a
 * mesma resposta da primeira vez.
 * - PROCESSED: 201, transação criada e aplicada.
 * - PENDING_REFERENCE: 202, aceita mas aguardando a BET referenciada.
 * - REJECTED: 422, gravada mas recusada por regra de negócio (failureCode no corpo).
 * - FAILED/PENDING: não são produzidos por este endpoint; 500 por segurança.
 */
export function httpStatusFor(tx: WagerTransaction): number {
  switch (tx.status()) {
    case 'PROCESSED':
      return 201;
    case 'PENDING_REFERENCE':
      return 202;
    case 'REJECTED':
      return 422;
    case 'FAILED':
    case 'PENDING':
      return 500;
  }
}
