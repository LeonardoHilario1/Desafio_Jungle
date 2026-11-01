import type { IntegrationEvent } from '../dominio/eventos/evento-integracao';
import type { OpenedWallet, Wallet } from '../dominio/carteira';
import type { WagerTransaction } from '../dominio/transacao-aposta';
import type { WalletLedgerEntry } from '../dominio/lancamento-ledger';

/** O que uma transação de aposta produz e precisa ser gravado no mesmo commit. */
export interface WagerChanges {
  wallet: Wallet;
  transaction: WagerTransaction;
  entry: WalletLedgerEntry | null;
  events: IntegrationEvent<unknown>[];
}

/**
 * Porta de persistência dos casos de uso de carteira e aposta. Todos os métodos operam
 * dentro de uma única transação SQL aberta por WageringUnitOfWork.run.
 */
export interface WageringStore {
  /** SELECT ... FOR UPDATE da carteira; null se não existe. */
  lockWallet(walletId: string): Promise<Wallet | null>;
  findWallet(walletId: string): Promise<Wallet | null>;
  findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | null>;
  findTransaction(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Existe REFUND ou ROLLBACK PROCESSED desta referência. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insertWallet(opened: OpenedWallet, events: IntegrationEvent<unknown>[]): Promise<void>;
  /** Grava transação (nova ou atualizada), saldo, lançamento e eventos da outbox. */
  saveWager(changes: WagerChanges): Promise<void>;
}

export interface WageringUnitOfWork {
  /** Executa fn numa transação SQL; commit se resolver, rollback se lançar. */
  run<T>(fn: (store: WageringStore) => Promise<T>): Promise<T>;
  /** Leituras fora de transação explícita. */
  read<T>(fn: (store: WageringStore) => Promise<T>): Promise<T>;
}

export const WAGERING_UNIT_OF_WORK = Symbol('WAGERING_UNIT_OF_WORK');

/*
 * Falhas de persistência que os casos de uso tratam. A implementação da porta traduz
 * as exceções do driver (violação de UNIQUE, lock_timeout) para estas classes, e o
 * caso de uso não conhece nomes de constraint.
 */

/** Outra requisição gravou primeiro a mesma Idempotency-Key ou o mesmo id externo. */
export class DuplicateTransactionError extends Error {
  constructor(readonly key: 'IDEMPOTENCY_KEY' | 'EXTERNAL_ID') {
    super(`Transação duplicada (${key})`);
    this.name = 'DuplicateTransactionError';
  }
}

/** Já existe carteira para o jogador e a moeda. */
export class DuplicateWalletError extends Error {
  constructor() {
    super('Carteira duplicada');
    this.name = 'DuplicateWalletError';
  }
}

/** Estourou o lock_timeout esperando o lock da carteira. */
export class LockTimeoutError extends Error {
  constructor() {
    super('Tempo esgotado esperando o lock da carteira');
    this.name = 'LockTimeoutError';
  }
}
