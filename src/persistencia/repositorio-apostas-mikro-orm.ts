import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  DuplicateTransactionError,
  DuplicateWalletError,
  LockTimeoutError,
  type WagerChanges,
  type WageringStore,
  type WageringUnitOfWork,
} from '../aplicacao/repositorio-apostas';
import type { IntegrationEvent } from '../dominio/eventos/evento-integracao';
import { OutboxMessage } from '../dominio/mensagem-outbox';
import type { WagerTransaction } from '../dominio/transacao-aposta';
import type { OpenedWallet, Wallet } from '../dominio/carteira';
import { isLockTimeout, isUniqueViolation } from './erros-banco';
import { Money } from '../dominio/dinheiro';
import type { WalletLedgerEntry } from '../dominio/lancamento-ledger';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './esquemas-entidades';
import {
  ledgerEntryFromRecord,
  transactionFromRecord,
  walletFromRecord,
  writeLedgerEntry,
  writeOutboxMessage,
  writeTransaction,
  writeWallet,
} from './mapeadores';

// quanto tempo espero o lock de uma carteira antes de desistir (WALLET_BUSY)
const LOCK_TIMEOUT = '5s';

/** implementação da porta com MikroORM: uma transação SQL por run, em READ COMMITTED */
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
 * store em cima de um EntityManager. guardo os records que carreguei pra que o save escreva
 * no record gerenciado (UPDATE pelo Unit of Work) em vez de criar outro.
 *
 * como as FKs não estão declaradas como relações no MikroORM, eu forço a ordem dos INSERTs
 * com flushes em sequência: carteira, transação, depois lançamento e outbox.
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

  async listLedger(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit },
    );
    return records.map(ledgerEntryFromRecord);
  }

  async ledgerSnapshot(walletId: string) {
    // uma query só: no READ COMMITTED cada comando vê um snapshot, então saldo e soma do
    // ledger saem do mesmo instante, mesmo com escrita acontecendo em paralelo
    const [row] = await this.em.getConnection().execute<
      { currency: string; balance: string; calculated: string; entries: number }[]
    >(
      `select w.currency, w.balance,
              coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(18,2)::text
                as calculated,
              count(e.id)::int as entries
         from wallets w
         left join wallet_ledger_entries e on e.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) return null;
    const money = (amount: string) => Money.from({ amount, currency: row.currency });
    // a soma do ledger pode dar negativa se algo muito errado acontecer; Money.from não
    // aceita sinal, então monto pelo zero
    const calculated = row.calculated.startsWith('-')
      ? Money.zero(row.currency).subtract(money(row.calculated.slice(1)))
      : money(row.calculated);
    return { stored: money(row.balance), calculated, entries: row.entries };
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
