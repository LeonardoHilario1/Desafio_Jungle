import { Inject, Injectable } from '@nestjs/common';
import type { EventContext } from '../dominio/eventos/evento-integracao';
import { eventsFor } from '../dominio/eventos/eventos-apostas';
import { Money, type MoneyProps } from '../dominio/dinheiro';
import { Wallet } from '../dominio/carteira';
import { ApplicationError } from './erro-aplicacao';
import { DuplicateWalletError, WAGERING_UNIT_OF_WORK, type WageringUnitOfWork } from './repositorio-apostas';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/**
 * abre a carteira. se tiver saldo inicial, grava junto (mesma transação SQL) a OPENING,
 * o lançamento CREDIT e os eventos. quem garante uma carteira por (player_id, currency)
 * é o banco: se duas chegarem ao mesmo tempo, uma cria e a outra recebe conflito com o
 * id da que já existe.
 */
@Injectable()
export class OpenWallet {
  constructor(@Inject(WAGERING_UNIT_OF_WORK) private readonly uow: WageringUnitOfWork) {}

  async execute(command: OpenWalletCommand, ctx: EventContext): Promise<Wallet> {
    const opened = Wallet.open({ playerId: command.playerId, initialBalance: Money.from(command.initialBalance) });
    const events = opened.opening
      ? eventsFor(opened.opening.transaction, opened.wallet, opened.opening.entry, ctx)
      : [];
    try {
      await this.uow.run((store) => store.insertWallet(opened, events));
      return opened.wallet;
    } catch (error) {
      if (!(error instanceof DuplicateWalletError)) throw error;
      const existing = await this.uow.read((store) =>
        store.findWalletByPlayer(opened.wallet.playerId, opened.wallet.currency),
      );
      throw new ApplicationError('WALLET_ALREADY_EXISTS', 'Já existe carteira para este jogador e moeda', {
        ...(existing && { walletId: existing.id }),
      });
    }
  }
}
