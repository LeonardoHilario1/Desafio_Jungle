import { Inject, Injectable } from '@nestjs/common';
import type { EventContext } from '../domain/events/integration-event';
import { eventsFor } from '../domain/events/wagering-events';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { ApplicationError } from './application-error';
import { DuplicateWalletError, WAGERING_UNIT_OF_WORK, type WageringUnitOfWork } from './wagering-store';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/**
 * Abre a carteira. Saldo inicial maior que zero grava, na mesma transação SQL, a
 * transação OPENING, o lançamento CREDIT e os eventos. A unicidade (player_id, currency)
 * é do banco: duas criações simultâneas resultam em uma carteira e um conflito que
 * informa o id da existente.
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
