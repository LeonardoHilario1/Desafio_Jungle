import type { WagerResult } from '../aplicacao/processar-transacao-aposta';
import type { MoneyProps } from '../dominio/dinheiro';
import type {
  TransactionFailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../dominio/transacao-aposta';

/** resposta do POST /wagering/transactions */
export interface SubmitView {
  transactionId: string;
  status: WagerTransactionStatus;
  /** saldo que a transação viu quando chegou no estado atual (o replay devolve o mesmo) */
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: TransactionFailureCode;
}

export function presentSubmit({ transaction: tx, idempotentReplay }: WagerResult): SubmitView {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance?.toJSON() ?? null,
    idempotentReplay,
    ...(tx.failureCode !== null && { failureCode: tx.failureCode }),
  };
}

/** transação completa, pras consultas */
export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: TransactionFailureCode | null;
  balance: MoneyProps | null;
  correlationId: string;
  createdAt: string;
  processedAt: string | null;
}

export function presentTransaction(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    status: tx.status,
    failureCode: tx.failureCode,
    balance: tx.observedBalance?.toJSON() ?? null,
    correlationId: tx.correlationId,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

/**
 * o status HTTP sai só do estado gravado, assim o replay devolve exatamente a mesma resposta.
 * - PROCESSED: 201, aplicada.
 * - PENDING_REFERENCE: 202, aceitei mas tô esperando a referência; vai ser reprocessada.
 * - REJECTED: 422, gravada mas recusada por regra de negócio (failureCode no corpo).
 * - FAILED: 500, falha permanente de infra registrada (só acontece pela fila).
 * - PENDING: nunca é commitada; deixei 500 por segurança.
 */
export function httpStatusFor(tx: WagerTransaction): number {
  switch (tx.status) {
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
