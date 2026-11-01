import { EntitySchema, type EntityCtor } from '@mikro-orm/core';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { FailureCode } from '../domain/domain-error';
import type { LedgerDirection } from '../domain/wallet-ledger-entry';
import type { TransactionStatus, WagerType } from '../domain/wager-transaction';

/*
 * Mapeamento sem decorators. O tipo de cada coluna é declarado explicitamente
 * (type + columnType), sem inferência por design:type. As tabelas e constraints vêm
 * das migrations SQL; este arquivo precisa refletir esse schema.
 *
 * Os tipos *Row descrevem os campos persistidos, inclusive os privados das classes
 * de domínio, que o TypeScript não expõe em keyof. O cast em `class` é o único ponto
 * em que a tipagem é contornada.
 *
 * Valores numeric(18,2) são lidos e gravados como string: o driver pg devolve numeric
 * como string, e o domínio converte para Money. Nenhum valor monetário passa por number.
 */

const decimal = { type: 'string', columnType: 'numeric(18,2)' } as const;
const timestamptz = { type: 'Date', columnType: 'timestamptz' } as const;

interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  versionNumber: number;
  createdAt: Date;
  lastUpdatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  class: Wallet as unknown as EntityCtor<WalletRow>,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', columnType: 'uuid', primary: true },
    playerId: { type: 'string', columnType: 'varchar(255)', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceAmount: { ...decimal, fieldName: 'balance' },
    versionNumber: { type: 'integer', columnType: 'integer', fieldName: 'version' },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
    lastUpdatedAt: { ...timestamptz, fieldName: 'updated_at' },
  },
});

interface WagerTransactionRow {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  type: WagerType;
  currency: string;
  amountValue: string;
  referenceKey: string | null;
  referenceTransactionIdValue: string | null;
  statusValue: TransactionStatus;
  failureCodeValue: FailureCode | null;
  createdAt: Date;
  processedAtValue: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransaction as unknown as EntityCtor<WagerTransactionRow>,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', columnType: 'uuid', primary: true },
    idempotencyKey: { type: 'string', columnType: 'varchar(255)', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', columnType: 'uuid', fieldName: 'wallet_id' },
    type: { type: 'string', columnType: 'varchar(16)' },
    currency: { type: 'string', columnType: 'char(3)' },
    amountValue: { ...decimal, fieldName: 'amount' },
    referenceKey: { type: 'string', columnType: 'varchar(255)', fieldName: 'reference_key', nullable: true },
    referenceTransactionIdValue: {
      type: 'uuid',
      columnType: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    statusValue: { type: 'string', columnType: 'varchar(32)', fieldName: 'status' },
    failureCodeValue: { type: 'string', columnType: 'varchar(64)', fieldName: 'failure_code', nullable: true },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
    processedAtValue: { ...timestamptz, fieldName: 'processed_at', nullable: true },
  },
});

interface WalletLedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  currency: string;
  amountValue: string;
  balanceAfterValue: string;
  createdAt: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  class: WalletLedgerEntry as unknown as EntityCtor<WalletLedgerEntryRow>,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', columnType: 'uuid', primary: true },
    walletId: { type: 'uuid', columnType: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', columnType: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', columnType: 'varchar(6)' },
    currency: { type: 'string', columnType: 'char(3)' },
    amountValue: { ...decimal, fieldName: 'amount' },
    balanceAfterValue: { ...decimal, fieldName: 'balance_after' },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
  },
});

export const entitySchemas = [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema];
