import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WalletLedgerEntry } from '../dominio/lancamento-ledger';
import { Reconciliation } from '../dominio/reconciliacao';
import type { WagerTransaction } from '../dominio/transacao-aposta';
import type { Wallet } from '../dominio/carteira';
import { ApplicationError } from './erro-aplicacao';
import { WAGERING_UNIT_OF_WORK, type WageringUnitOfWork } from './repositorio-apostas';

/** só leitura, sem lock */
export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** posição depois do último item, ou null se não tem mais nada */
  nextAfterVersion: number | null;
}

@Injectable()
export class WageringQueries {
  private readonly logger = new Logger(WageringQueries.name);

  constructor(@Inject(WAGERING_UNIT_OF_WORK) private readonly uow: WageringUnitOfWork) {}

  async wallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((store) => store.findWallet(walletId));
    if (!wallet) throw new ApplicationError('WALLET_NOT_FOUND', `Carteira ${walletId} não encontrada`);
    return wallet;
  }

  async transaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((store) => store.findTransaction(transactionId));
    if (!tx) throw new ApplicationError('TRANSACTION_NOT_FOUND', `Transação ${transactionId} não encontrada`);
    return tx;
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((store) => store.findByExternalId(providerId, externalTransactionId));
    if (!tx) {
      throw new ApplicationError(
        'TRANSACTION_NOT_FOUND',
        `Transação ${externalTransactionId} do provedor ${providerId} não encontrada`,
      );
    }
    return tx;
  }

  /** página do ledger em ordem de wallet_version; o cursor é a última versão vista */
  async ledger(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    await this.wallet(walletId);
    // peço um a mais pra saber se tem próxima página sem fazer outra query
    const rows = await this.uow.read((store) => store.listLedger(walletId, afterVersion, limit + 1));
    const items = rows.slice(0, limit);
    return { items, nextAfterVersion: rows.length > limit ? items[items.length - 1]!.walletVersion : null };
  }

  /**
   * confere o saldo gravado contra o ledger. divergência não é corrigida aqui: vai pro
   * log, pra métrica e volta sinalizada na resposta.
   */
  async reconcile(walletId: string): Promise<Reconciliation> {
    const snapshot = await this.uow.read((store) => store.ledgerSnapshot(walletId));
    if (!snapshot) throw new ApplicationError('WALLET_NOT_FOUND', `Carteira ${walletId} não encontrada`);
    const result = Reconciliation.of({
      walletId,
      storedBalance: snapshot.stored,
      calculatedBalance: snapshot.calculated,
      checkedEntries: snapshot.entries,
    });
    if (!result.consistent) {
      this.logger.warn(`divergência de saldo na carteira ${walletId}: diferença ${result.difference}`);
    }
    return result;
  }
}
