import type { TransactionFailureCode, WagerTransaction, WagerTransactionKind } from '../wager-transaction';
import type { MoneyProps } from '../money';
import type { Wallet } from '../wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry';
import { deterministicEventId, IntegrationEvent, type EventContext } from './integration-event';

/** Campos comuns aos eventos de transação. */
export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
  };
}

function baseProps<T>(eventType: string, aggregateId: string, tx: WagerTransaction, ctx: EventContext, data: T) {
  return {
    eventId: deterministicEventId(`${tx.id}:${eventType}`),
    aggregateId,
    correlationId: ctx.correlationId,
    ...(ctx.causationId !== undefined && { causationId: ctx.causationId }),
    occurredAt: tx.processedAt ?? new Date(),
    data,
  };
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  walletVersion: number;
}

/** Qualquer transação aplicada, inclusive LOSS e OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      baseProps('WagerTransactionProcessed', tx.id, tx, ctx, {
        ...transactionData(tx),
        referenceTransactionId: tx.referenceTransactionId,
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: TransactionFailureCode;
  balance: MoneyProps;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionRejected {
    if (tx.failureCode === null) throw new Error('Transação rejeitada sem failureCode');
    return new WagerTransactionRejected(
      baseProps('WagerTransactionRejected', tx.id, tx, ctx, {
        ...transactionData(tx),
        failureCode: tx.failureCode,
        balance: wallet.balance.toJSON(),
      }),
    );
  }
}

/** Referência ausente: a transação aguarda e será reprocessada. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      baseProps('WagerTransactionPendingReference', tx.id, tx, ctx, transactionData(tx)),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. aggregateId é a carteira. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, tx: WagerTransaction, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      baseProps('WalletBalanceChanged', wallet.id, tx, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}

/** Eventos que o resultado de uma transação gera, na ordem em que vão para a outbox. */
export function eventsFor(
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | null,
  ctx: EventContext,
): IntegrationEvent<unknown>[] {
  switch (tx.status) {
    case 'PROCESSED':
      return [
        WagerTransactionProcessed.from(tx, wallet, ctx),
        ...(entry ? [WalletBalanceChanged.from(wallet, entry, tx, ctx)] : []),
      ];
    case 'REJECTED':
      return [WagerTransactionRejected.from(tx, wallet, ctx)];
    case 'PENDING_REFERENCE':
      return [WagerTransactionPendingReference.from(tx, ctx)];
    case 'PENDING':
    case 'FAILED':
      return [];
  }
}
