import { LockMode } from '@mikro-orm/core';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../api/api-error';
import { Money } from '../domain/money';
import { WagerTransaction, type WagerType } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { isLockTimeout, isUniqueViolation } from '../persistence/db-errors';
import { WagerTransactionSchema } from '../persistence/entity-schemas';
import { OutboxEvent } from '../outbox/outbox-event';

// Tempo máximo esperando o lock de uma carteira antes de responder 503.
const LOCK_TIMEOUT = '5s';

export interface TransactionInput {
  idempotencyKey: string;
  walletId: string;
  type: WagerType;
  amount: string;
  currency: string;
  referenceKey: string | null;
}

export interface SubmitResult {
  transaction: WagerTransaction;
  /** true quando a chave já tinha sido processada e o resultado gravado foi devolvido. */
  replayed: boolean;
}

/**
 * Processa uma transação de aposta em uma única transação de banco:
 *
 * 1. SELECT ... FOR UPDATE na carteira. Requisições para a mesma carteira são
 *    serializadas aqui; carteiras diferentes não disputam lock entre si.
 * 2. Com o lock na mão, procura a chave de idempotência. Em READ COMMITTED cada
 *    comando enxerga o que já foi commitado, então uma requisição concorrente com a
 *    mesma chave, que pegou o lock antes, já está visível: vira replay ou conflito.
 * 3. Aplica a regra (débito, crédito ou só liquidação) e grava transação, saldo e
 *    lançamento no mesmo commit.
 *
 * A mesma chave enviada em paralelo para carteiras diferentes não é serializada pelo
 * lock; nesse caso o UNIQUE de idempotency_key barra o segundo insert e o resultado
 * é decidido relendo o registro vencedor.
 */
@Injectable()
export class WageringService {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async submit(input: TransactionInput): Promise<SubmitResult> {
    // Valida a forma e calcula o payloadHash antes de abrir transação.
    const candidate = WagerTransaction.receive({
      idempotencyKey: input.idempotencyKey,
      walletId: input.walletId,
      type: input.type,
      amount: Money.of(input.amount, input.currency),
      referenceKey: input.referenceKey,
    });

    try {
      return await this.orm.em.fork().transactional((em) => this.process(em, candidate));
    } catch (error) {
      if (isUniqueViolation(error, 'wager_transactions_idempotency_key_uq')) {
        const winner = await this.orm.em.fork().findOneOrFail(WagerTransaction, {
          idempotencyKey: candidate.idempotencyKey,
        });
        return replayOrConflict(winner, candidate);
      }
      if (isLockTimeout(error)) {
        throw new ApiError(503, 'WALLET_BUSY', 'Carteira ocupada; tente novamente com a mesma Idempotency-Key');
      }
      throw error;
    }
  }

  private async process(em: EntityManager, candidate: WagerTransaction): Promise<SubmitResult> {
    await em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);

    const wallet = await em.findOne(Wallet, { id: candidate.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!wallet) {
      throw new ApiError(404, 'WALLET_NOT_FOUND', `Carteira ${candidate.walletId} não encontrada`);
    }

    const existing = await em.findOne(WagerTransaction, { idempotencyKey: candidate.idempotencyKey });
    if (existing) {
      return replayOrConflict(existing, candidate);
    }

    // A FK (wallet_id, currency) impediria gravar a transação; responde sem persistir.
    if (wallet.currency !== candidate.currency) {
      throw new ApiError(422, 'CURRENCY_MISMATCH', `Carteira em ${wallet.currency}, transação em ${candidate.currency}`);
    }

    const entry =
      candidate.type === 'BET' ? applyBet(wallet, candidate) : await this.applySettlement(em, wallet, candidate);

    // Ordem das FKs: a carteira já existe; transação antes do lançamento e do evento.
    // O evento entra no mesmo commit: ou tudo é gravado, ou nada (outbox transacional).
    await em.persist(candidate).flush();
    if (entry) {
      em.persist(entry);
    }
    await em.persist(OutboxEvent.forTransaction(candidate, wallet)).flush();
    return { transaction: candidate, replayed: false };
  }

  private async applySettlement(
    em: EntityManager,
    wallet: Wallet,
    settlement: WagerTransaction,
  ): Promise<WalletLedgerEntry | null> {
    const bet = await em.findOne(WagerTransaction, { idempotencyKey: settlement.referenceKey ?? '' });
    if (!bet) {
      // BET ainda não chegou (entrega fora de ordem). Reprocessar fica fora do MVP.
      settlement.awaitReference();
      return null;
    }

    const failure = settlement.linkReference(bet);
    if (failure) {
      settlement.reject(failure);
      return null;
    }

    // Seguro sem lock extra: a BET é da mesma carteira (validado acima), cujo lock
    // está conosco. O índice único parcial do banco é a garantia final.
    const settled = await em.count(WagerTransactionSchema, {
      referenceTransactionIdValue: bet.id,
      statusValue: 'PROCESSED',
      type: { $in: ['WIN', 'LOSS'] },
    });
    if (settled > 0) {
      settlement.reject('BET_ALREADY_SETTLED');
      return null;
    }

    const entry = settlement.type === 'WIN' ? wallet.credit(settlement.amount(), settlement.id) : null;
    settlement.markProcessed();
    return entry;
  }
}

function applyBet(wallet: Wallet, bet: WagerTransaction): WalletLedgerEntry | null {
  if (!wallet.canDebit(bet.amount())) {
    bet.reject('INSUFFICIENT_FUNDS');
    return null;
  }
  const entry = wallet.debit(bet.amount(), bet.id);
  bet.markProcessed();
  return entry;
}

function replayOrConflict(existing: WagerTransaction, candidate: WagerTransaction): SubmitResult {
  if (existing.payloadHash !== candidate.payloadHash) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key já usada com outro payload', {
      transactionId: existing.id,
    });
  }
  return { transaction: existing, replayed: true };
}
