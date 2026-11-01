import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export type OutboxEventType =
  | 'wager.transaction.processed'
  | 'wager.transaction.rejected'
  | 'wager.transaction.pending_reference';

export type OutboxPayload = Record<string, string | number | null>;

const EVENT_TYPE_BY_STATUS = {
  PROCESSED: 'wager.transaction.processed',
  REJECTED: 'wager.transaction.rejected',
  PENDING_REFERENCE: 'wager.transaction.pending_reference',
} as const satisfies Partial<Record<ReturnType<WagerTransaction['status']>, OutboxEventType>>;

/**
 * Evento a publicar no SQS, gravado na mesma transação de banco que a transação de
 * aposta, o saldo e o ledger. Só o publisher envia, e só lê linhas já commitadas.
 *
 * Os valores monetários vão como string. walletVersion permite ao consumidor ordenar
 * eventos da mesma carteira, já que a fila padrão não garante ordem.
 */
export class OutboxEvent {
  private constructor(
    readonly id: string,
    readonly eventType: OutboxEventType,
    readonly aggregateId: string,
    readonly payload: OutboxPayload,
    readonly createdAt: Date,
  ) {}

  static forTransaction(tx: WagerTransaction, wallet: Wallet): OutboxEvent {
    const status = tx.status();
    if (status !== 'PROCESSED' && status !== 'REJECTED' && status !== 'PENDING_REFERENCE') {
      throw new Error(`Transação em ${status} não gera evento`);
    }
    const id = crypto.randomUUID();
    return new OutboxEvent(
      id,
      EVENT_TYPE_BY_STATUS[status],
      tx.id,
      {
        eventId: id,
        transactionId: tx.id,
        idempotencyKey: tx.idempotencyKey,
        walletId: tx.walletId,
        type: tx.type,
        amount: tx.amount().amount,
        currency: tx.currency,
        referenceKey: tx.referenceKey,
        status,
        failureCode: tx.failureCode(),
        walletBalance: wallet.balance().amount,
        walletVersion: wallet.version(),
        occurredAt: (tx.processedAt() ?? tx.createdAt).toISOString(),
      },
      new Date(),
    );
  }
}
