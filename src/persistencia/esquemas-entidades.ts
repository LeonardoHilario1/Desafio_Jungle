import { EntitySchema } from '@mikro-orm/core';

/*
 * records de persistência: classes simples, uma por tabela, que o MikroORM gerencia
 * (Unit of Work, Identity Map, LockMode). o domínio não depende delas nem do ORM; a
 * conversão fica em mapeadores.ts.
 *
 * declaro o tipo de cada coluna explicitamente (type + columnType), nada de inferir por
 * design:type. tabelas e constraints vêm das migrations SQL, então este arquivo tem que
 * bater com esse schema.
 *
 * numeric(18,2) é lido e gravado como string: o driver pg já devolve numeric como string
 * e os mappers convertem pra Money. nenhum valor de dinheiro passa por number.
 */

const decimal = { type: 'string', columnType: 'numeric(18,2)' } as const;
const timestamptz = { type: 'Date', columnType: 'timestamptz' } as const;
const text255 = { type: 'string', columnType: 'varchar(255)' } as const;

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', columnType: 'uuid', primary: true },
    playerId: { ...text255, fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { ...decimal },
    version: { type: 'integer', columnType: 'integer' },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
    updatedAt: { ...timestamptz, fieldName: 'updated_at' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  currency!: string;
  amount!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  correlationId!: string;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  observedCurrency!: string | null;
  createdAt!: Date;
  processedAt!: Date | null;
  referenceAttempts!: number;
  nextReferenceCheckAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', columnType: 'uuid', primary: true },
    providerId: { ...text255, fieldName: 'provider_id' },
    externalTransactionId: { ...text255, fieldName: 'external_transaction_id' },
    idempotencyKey: { ...text255, fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', columnType: 'uuid', fieldName: 'wallet_id' },
    playerId: { ...text255, fieldName: 'player_id' },
    roundId: { ...text255, fieldName: 'round_id', nullable: true },
    gameId: { ...text255, fieldName: 'game_id', nullable: true },
    kind: { type: 'string', columnType: 'varchar(16)' },
    currency: { type: 'string', columnType: 'char(3)' },
    amount: { ...decimal },
    referenceExternalTransactionId: { ...text255, fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', columnType: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    correlationId: { ...text255, fieldName: 'correlation_id' },
    status: { type: 'string', columnType: 'varchar(32)' },
    failureCode: { type: 'string', columnType: 'varchar(64)', fieldName: 'failure_code', nullable: true },
    observedBalance: { ...decimal, fieldName: 'observed_balance', nullable: true },
    observedCurrency: { type: 'string', columnType: 'char(3)', fieldName: 'observed_currency', nullable: true },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
    processedAt: { ...timestamptz, fieldName: 'processed_at', nullable: true },
    referenceAttempts: { type: 'integer', columnType: 'integer', fieldName: 'reference_attempts' },
    nextReferenceCheckAt: { ...timestamptz, fieldName: 'next_reference_check_at', nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  currency!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', columnType: 'uuid', primary: true },
    walletId: { type: 'uuid', columnType: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', columnType: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', columnType: 'varchar(6)' },
    currency: { type: 'string', columnType: 'char(3)' },
    amount: { ...decimal },
    balanceBefore: { ...decimal, fieldName: 'balance_before' },
    balanceAfter: { ...decimal, fieldName: 'balance_after' },
    walletVersion: { type: 'integer', columnType: 'integer', fieldName: 'wallet_version' },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
  /** diagnóstico do publisher; não faz parte do domínio */
  lastError: string | null = null;
}

// created_at fica só no banco (default now())
export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', columnType: 'uuid', primary: true },
    aggregateId: { type: 'uuid', columnType: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', columnType: 'varchar(64)', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { ...timestamptz, fieldName: 'occurred_at' },
    attempts: { type: 'integer', columnType: 'integer' },
    nextAttemptAt: { ...timestamptz, fieldName: 'next_attempt_at', nullable: true },
    publishedAt: { ...timestamptz, fieldName: 'published_at', nullable: true },
    lastError: { type: 'text', columnType: 'text', fieldName: 'last_error', nullable: true },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  transactionId!: string;
  receivedAt!: Date;
  processedAt!: Date;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', columnType: 'varchar(64)', fieldName: 'consumer_name', primary: true },
    messageId: { ...text255, fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' },
    transactionId: { type: 'uuid', columnType: 'uuid', fieldName: 'transaction_id' },
    receivedAt: { ...timestamptz, fieldName: 'received_at' },
    processedAt: { ...timestamptz, fieldName: 'processed_at' },
  },
});

export const entitySchemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  InboxMessageSchema,
];
