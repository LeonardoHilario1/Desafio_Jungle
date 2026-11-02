import type { TransactionFailureCode, WagerTransactionKind, WagerTransactionStatus } from '../dominio/transacao-aposta';
import { Money } from '../dominio/dinheiro';
import { OutboxMessage } from '../dominio/mensagem-outbox';
import { WagerTransaction } from '../dominio/transacao-aposta';
import { Wallet } from '../dominio/carteira';
import { WalletLedgerEntry, type LedgerDirection } from '../dominio/lancamento-ledger';
import { InboxMessage } from '../dominio/mensagem-inbox';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './esquemas-entidades';

/*
 * conversão entre records (persistência) e domínio. pra ler uso as factories rehydrate,
 * que não revalidam transição. pra gravar copio o estado do domínio pro record gerenciado
 * e o Unit of Work do MikroORM gera o INSERT/UPDATE no flush.
 *
 * Money ocupa duas colunas (valor numeric e moeda char(3)) e volta com Money.from, que
 * aceita exatamente o formato que o PostgreSQL devolve.
 */

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

export function walletFromRecord(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function writeWallet(w: Wallet, r: WalletRecord = new WalletRecord()): WalletRecord {
  r.id = w.id;
  r.playerId = w.playerId;
  r.currency = w.currency;
  r.balance = w.balance.amount;
  r.version = w.version;
  r.createdAt = w.createdAt;
  r.updatedAt = w.updatedAt;
  return r;
}

export function transactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId,
    correlationId: r.correlationId,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId,
    failureCode: r.failureCode as TransactionFailureCode | null,
    processedAt: r.processedAt,
    observedBalance:
      r.observedBalance === null || r.observedCurrency === null ? null : money(r.observedBalance, r.observedCurrency),
    referenceAttempts: r.referenceAttempts,
    nextReferenceCheckAt: r.nextReferenceCheckAt,
  });
}

export function writeTransaction(
  t: WagerTransaction,
  r: WagerTransactionRecord = new WagerTransactionRecord(),
): WagerTransactionRecord {
  r.id = t.id;
  r.providerId = t.providerId;
  r.externalTransactionId = t.externalTransactionId;
  r.idempotencyKey = t.idempotencyKey;
  r.payloadHash = t.payloadHash;
  r.walletId = t.walletId;
  r.playerId = t.playerId;
  r.roundId = t.roundId;
  r.gameId = t.gameId;
  r.kind = t.kind;
  r.currency = t.money.currency;
  r.amount = t.money.amount;
  r.referenceExternalTransactionId = t.referenceExternalTransactionId;
  r.referenceTransactionId = t.referenceTransactionId;
  r.correlationId = t.correlationId;
  r.status = t.status;
  r.failureCode = t.failureCode;
  // o saldo observado é da carteira, e a moeda dela pode ser diferente da transação (CURRENCY_MISMATCH)
  r.observedBalance = t.observedBalance?.amount ?? null;
  r.observedCurrency = t.observedBalance?.currency ?? null;
  r.createdAt = t.createdAt;
  r.processedAt = t.processedAt;
  r.referenceAttempts = t.referenceAttempts;
  r.nextReferenceCheckAt = t.nextReferenceCheckAt;
  return r;
}

export function ledgerEntryFromRecord(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}

export function writeLedgerEntry(e: WalletLedgerEntry): LedgerEntryRecord {
  const r = new LedgerEntryRecord();
  r.id = e.id;
  r.walletId = e.walletId;
  r.transactionId = e.transactionId;
  r.direction = e.direction;
  r.currency = e.money.currency;
  r.amount = e.money.amount;
  r.balanceBefore = e.balanceBefore.amount;
  r.balanceAfter = e.balanceAfter.amount;
  r.walletVersion = e.walletVersion;
  r.createdAt = e.createdAt;
  return r;
}

export function outboxFromRecord(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    publishedAt: r.publishedAt,
  });
}

export function writeOutboxMessage(m: OutboxMessage, r: OutboxMessageRecord = new OutboxMessageRecord()): OutboxMessageRecord {
  r.id = m.id;
  r.aggregateId = m.aggregateId;
  r.eventType = m.eventType;
  r.payload = { ...m.payload };
  r.occurredAt = m.occurredAt;
  r.attempts = m.attempts;
  r.nextAttemptAt = m.nextAttemptAt;
  r.publishedAt = m.publishedAt;
  return r;
}

export function inboxFromRecord(r: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: r.processedAt,
  });
}

export function writeInboxMessage(m: InboxMessage, transactionId: string): InboxMessageRecord {
  if (m.processedAt === null) throw new Error(`Mensagem ${m.messageId} gravada sem estar processada`);
  const r = new InboxMessageRecord();
  r.consumerName = m.consumerName;
  r.messageId = m.messageId;
  r.payloadHash = m.payloadHash;
  r.transactionId = transactionId;
  r.receivedAt = m.receivedAt;
  r.processedAt = m.processedAt;
  return r;
}
