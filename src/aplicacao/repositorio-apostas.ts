import type { IntegrationEvent } from '../dominio/eventos/evento-integracao';
import type { OpenedWallet, Wallet } from '../dominio/carteira';
import type { WagerTransaction } from '../dominio/transacao-aposta';
import type { WalletLedgerEntry } from '../dominio/lancamento-ledger';
import type { Money } from '../dominio/dinheiro';
import type { InboxMessage } from '../dominio/mensagem-inbox';

/** tudo que uma transação de aposta gera e tem que ir no mesmo commit */
export interface WagerChanges {
  wallet: Wallet;
  transaction: WagerTransaction;
  entry: WalletLedgerEntry | null;
  events: IntegrationEvent<unknown>[];
}

/**
 * porta de persistência dos casos de uso. todo método roda dentro da transação SQL que o
 * WageringUnitOfWork.run abriu.
 */
export interface WageringStore {
  /** SELECT ... FOR UPDATE da carteira; null se não existir */
  lockWallet(walletId: string): Promise<Wallet | null>;
  findWallet(walletId: string): Promise<Wallet | null>;
  findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | null>;
  findTransaction(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** true se já tem REFUND ou ROLLBACK PROCESSED dessa referência */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** lançamentos com wallet_version > afterVersion, em ordem, no máximo limit */
  listLedger(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  /**
   * saldo gravado e saldo somado do ledger, lidos no mesmo snapshot (uma query só);
   * null se a carteira não existe
   */
  ledgerSnapshot(walletId: string): Promise<{ stored: Money; calculated: Money; entries: number } | null>;
  /** PENDING_REFERENCE da carteira esperando por (providerId, externalTransactionId) */
  findPendingDependents(walletId: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction[]>;
  /** pendências com checagem vencida, sem lock (o worker trava a carteira depois) */
  findDueReferenceChecks(now: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
  findInbox(consumerName: string, messageId: string): Promise<{ message: InboxMessage; transactionId: string } | null>;
  insertInbox(message: InboxMessage, transactionId: string): Promise<void>;
  insertWallet(opened: OpenedWallet, events: IntegrationEvent<unknown>[]): Promise<void>;
  /** grava a transação (nova ou atualizada), o saldo, o lançamento e os eventos da outbox */
  saveWager(changes: WagerChanges): Promise<void>;
}

export interface WageringUnitOfWork {
  /** roda fn numa transação SQL: commit se der certo, rollback se lançar */
  run<T>(fn: (store: WageringStore) => Promise<T>): Promise<T>;
  /** leituras sem transação explícita */
  read<T>(fn: (store: WageringStore) => Promise<T>): Promise<T>;
}

export const WAGERING_UNIT_OF_WORK = Symbol('WAGERING_UNIT_OF_WORK');

/*
 * falhas de persistência que o caso de uso precisa tratar. a implementação da porta
 * converte as exceções do driver (UNIQUE violado, lock_timeout) nessas classes, assim o
 * caso de uso não precisa conhecer nome de constraint.
 */

/** outra requisição gravou antes a mesma Idempotency-Key ou o mesmo id externo */
export class DuplicateTransactionError extends Error {
  constructor(readonly key: 'IDEMPOTENCY_KEY' | 'EXTERNAL_ID') {
    super(`Transação duplicada (${key})`);
    this.name = 'DuplicateTransactionError';
  }
}

/** a mesma mensagem foi gravada na inbox por outro consumidor no mesmo instante */
export class DuplicateInboxError extends Error {
  constructor() {
    super('Mensagem duplicada na inbox');
    this.name = 'DuplicateInboxError';
  }
}

/** já tem carteira pra esse jogador nessa moeda */
export class DuplicateWalletError extends Error {
  constructor() {
    super('Carteira duplicada');
    this.name = 'DuplicateWalletError';
  }
}

/** estourou o lock_timeout esperando o lock da carteira */
export class LockTimeoutError extends Error {
  constructor() {
    super('Tempo esgotado esperando o lock da carteira');
    this.name = 'LockTimeoutError';
  }
}
