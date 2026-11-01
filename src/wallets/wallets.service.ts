import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../api/api-error';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { isUniqueViolation } from '../persistence/db-errors';

export interface OpenWalletInput {
  playerId: string;
  currency: string;
  /** Saldo inicial opcional, registrado no ledger como lançamento de abertura. */
  initialBalance: string | null;
}

@Injectable()
export class WalletsService {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  /**
   * Abre a carteira. A unicidade (player_id, currency) é do banco: duas criações
   * simultâneas resultam em uma 201 e uma 409, que informa o id da existente.
   */
  async open(input: OpenWalletInput): Promise<Wallet> {
    const initialBalance = Money.of(input.initialBalance ?? '0', input.currency);
    const { wallet, openingEntry } = initialBalance.isZero()
      ? { wallet: Wallet.open({ playerId: input.playerId, currency: input.currency }), openingEntry: null }
      : Wallet.openWithBalance({ playerId: input.playerId, initialBalance });

    try {
      await this.orm.em.fork().transactional(async (em) => {
        // Ordem das FKs: carteira antes do lançamento.
        await em.persist(wallet).flush();
        if (openingEntry) {
          await em.persist(openingEntry).flush();
        }
      });
      return wallet;
    } catch (error) {
      if (!isUniqueViolation(error, 'wallets_player_currency_uq')) throw error;
      const existing = await this.orm.em.fork().findOneOrFail(Wallet, {
        playerId: wallet.playerId,
        currency: wallet.currency,
      });
      throw new ApiError(409, 'WALLET_ALREADY_EXISTS', 'Já existe carteira para este jogador e moeda', {
        walletId: existing.id,
      });
    }
  }

  async get(id: string): Promise<Wallet> {
    const wallet = await this.orm.em.fork().findOne(Wallet, { id });
    if (!wallet) {
      throw new ApiError(404, 'WALLET_NOT_FOUND', `Carteira ${id} não encontrada`);
    }
    return wallet;
  }
}
