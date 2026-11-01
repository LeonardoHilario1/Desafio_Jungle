import { Inject, Injectable } from '@nestjs/common';
import type { WagerTransaction } from '../dominio/transacao-aposta';
import type { Wallet } from '../dominio/carteira';
import { ApplicationError } from './erro-aplicacao';
import { WAGERING_UNIT_OF_WORK, type WageringUnitOfWork } from './repositorio-apostas';

/** Consultas de leitura, sem lock. */
@Injectable()
export class WageringQueries {
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
}
