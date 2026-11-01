import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  DuplicateTransactionError,
  DuplicateWalletError,
  LockTimeoutError,
  type WagerChanges,
  type WageringStore,
  type WageringUnitOfWork,
} from '../application/wagering-store';
import type { IntegrationEvent } from '../domain/events/integration-event';
import { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { OpenedWallet, Wallet } from '../domain/wallet';
import { isLockTimeout, isUniqueViolation } from './db-errors';
import { WagerTransactionRecord, WalletRecord } from './entity-schemas';
import {
  transactionFromRecord,
  walletFromRecord,
  writeLedgerEntry,
  writeOutboxMessage,
  writeTransaction,
  writeWallet,
} from './mappers';

// Tempo máximo esperando o lock de uma carteira antes de desistir (WALLET_BUSY).
const LOCK_TIMEOUT = '5s';

/** Implementação da porta com MikroORM: uma transação SQL por run, isolamento READ COMMITTED. */
export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(fn: (store: WageringStore) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
        return fn(new MikroOrmWageringStore(em));
      });
    } catch (error) {
      throw translate(error);
    }
  }

  read<T>(fn: (store: WageringStore) => Promise<T>): Promise<T> {
    return fn(new MikroOrmWageringStore(this.orm.em.fork()));
  }
}

function translate(error: unknown): unknown {
  if (isUniqueViolation(error, 'wager_transactions_idempotency_key_uq')) {
    return new DuplicateTransactionError('IDEMPOTENCY_KEY');
  }
  if (isUniqueViolation(error, 'wager_transactions_provider_external_uq')) {
    return new DuplicateTransactionError('EXTERNAL_ID');
  }
  if (isUniqueViolation(error, 'wallets_player_currency_uq')) return new DuplicateWalletError();
  if (isLockTimeout(error)) return new LockTimeoutError();
  return error;
}

/**
 * Store sobre um EntityManager. Guarda os records carregados para que o save escreva no
 * record gerenciado (UPDATE pelo Unit of Work) em vez de criar outro.
 *
 * As FKs não estão declaradas como relações no MikroORM, então a ordem dos INSERTs é
 * imposta com flushes em sequência: carteira, transação, depois lançamento e outbox.
 */
class MikroOrmWageringStore implements WageringStore {
  private readonly wallets = new Map<string, WalletRecord>();
  private readonly transactions = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? this.trackWallet(record) : null;
  }

  async findWallet(walletId: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id: walletId });
    return record ? this.trackWallet(record) : null;
  }

  async findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record ? this.trackWallet(record) : null;
  }

  async findTransaction(id: string): Promise<WagerTransaction | null> {
    return this.trackTransaction(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.trackTransaction(await this.em.findOne(WagerTransactionRecord, { idempotencyKey }));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.trackTransaction(await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async insertWallet(opened: OpenedWallet, events: IntegrationEvent<unknown>[]): Promise<void> {
    await this.em.persist(writeWallet(opened.wallet)).flush();
    if (opened.opening) {
      await this.em.persist(writeTransaction(opened.opening.transaction)).flush();
      this.em.persist(writeLedgerEntry(opened.opening.entry));
    }
    this.persistEvents(events);
    await this.em.flush();
  }

  async saveWager({ wallet, transaction, entry, events }: WagerChanges): Promise<void> {
    const walletRecord = this.wallets.get(wallet.id);
    if (!walletRecord) throw new Error(`Carteira ${wallet.id} não foi carregada por este store`);
    writeWallet(wallet, walletRecord);

    const existing = this.transactions.get(transaction.id);
    if (existing) {
      writeTransaction(transaction, existing);
    } else {
      this.em.persist(writeTransaction(transaction));
    }
    await this.em.flush();

    if (entry) this.em.persist(writeLedgerEntry(entry));
    this.persistEvents(events);
    await this.em.flush();
  }

  private persistEvents(events: IntegrationEvent<unknown>[]): void {
    for (const event of events) {
      this.em.persist(writeOutboxMessage(OutboxMessage.enqueue(event)));
    }
  }

  private trackWallet(record: WalletRecord): Wallet {
    this.wallets.set(record.id, record);
    return walletFromRecord(record);
  }

  private trackTransaction(record: WagerTransactionRecord | null): WagerTransaction | null {
    if (!record) return null;
    this.transactions.set(record.id, record);
    return transactionFromRecord(record);
  }
}
