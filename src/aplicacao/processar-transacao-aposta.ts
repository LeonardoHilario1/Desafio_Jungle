import { Inject, Injectable } from '@nestjs/common';
import type { EventContext } from '../dominio/eventos/evento-integracao';
import { eventsFor } from '../dominio/eventos/eventos-apostas';
import { Money, type MoneyProps } from '../dominio/dinheiro';
import { applyWager } from '../dominio/regras-aposta';
import { WagerTransaction, type SubmittableKind } from '../dominio/transacao-aposta';
import { ApplicationError } from './erro-aplicacao';
import {
  DuplicateTransactionError,
  LockTimeoutError,
  WAGERING_UNIT_OF_WORK,
  type WageringStore,
  type WageringUnitOfWork,
} from './repositorio-apostas';

/** comando de entrada, o mesmo pra HTTP e pra fila */
export interface WagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

export interface WagerResult {
  transaction: WagerTransaction;
  /** true quando a Idempotency-Key já existia e eu só devolvi o que estava gravado */
  idempotentReplay: boolean;
}

/**
 * caso de uso que processa uma transação de aposta. a API usa e o consumidor SQS vai usar.
 * tudo roda numa transação SQL só:
 *
 * 1. SELECT ... FOR UPDATE na carteira. é aqui que eu serializo as operações da mesma
 *    carteira, em qualquer instância; carteiras diferentes não brigam por lock.
 * 2. já com o lock, procuro a Idempotency-Key. como é READ COMMITTED, se outra requisição
 *    com a mesma chave pegou o lock antes, o commit dela já aparece pra mim: vira replay
 *    (mesmo payloadHash) ou conflito.
 * 3. resolvo a referência por (providerId, referenceExternalTransactionId), passo pelas
 *    regras (applyWager) e gravo transação, saldo, lançamento e eventos no mesmo commit.
 *
 * obs: a mesma chave em paralelo pra carteiras diferentes o lock não pega. aí quem segura
 * é o UNIQUE do banco, e eu decido a resposta relendo quem ganhou.
 */
@Injectable()
export class ProcessWagerTransaction {
  constructor(@Inject(WAGERING_UNIT_OF_WORK) private readonly uow: WageringUnitOfWork) {}

  async execute(command: WagerTransactionCommand, ctx: EventContext): Promise<WagerResult> {
    // valido a forma e calculo o payloadHash antes de abrir transação
    const candidate = WagerTransaction.create({ ...command, money: Money.from(command.money), correlationId: ctx.correlationId });

    try {
      return await this.uow.run((store) => this.process(store, candidate, ctx));
    } catch (error) {
      if (error instanceof DuplicateTransactionError) {
        return this.uow.read((store) => resolveDuplicate(store, candidate));
      }
      if (error instanceof LockTimeoutError) {
        throw new ApplicationError('WALLET_BUSY', 'Carteira ocupada; tente novamente com a mesma Idempotency-Key');
      }
      throw error;
    }
  }

  private async process(store: WageringStore, candidate: WagerTransaction, ctx: EventContext): Promise<WagerResult> {
    const wallet = await store.lockWallet(candidate.walletId);
    if (!wallet) {
      throw new ApplicationError('WALLET_NOT_FOUND', `Carteira ${candidate.walletId} não encontrada`);
    }

    const duplicate = await resolveDuplicate(store, candidate, { allowMissing: true });
    if (duplicate) return duplicate;

    const reference =
      candidate.referenceExternalTransactionId === null
        ? null
        : await store.findByExternalId(candidate.providerId, candidate.referenceExternalTransactionId);
    // a referência só é confiável sob o lock se for da mesma carteira. se for de outra,
    // applyWager rejeita antes de olhar o estado dela
    const referenceAlreadyReversed =
      reference !== null && candidate.isReversal() && (await store.hasProcessedReversal(reference.id));

    const outcome = applyWager(wallet, candidate, { reference, referenceAlreadyReversed });
    const entry = outcome.status === 'PROCESSED' ? outcome.entry : null;
    await store.saveWager({
      wallet,
      transaction: candidate,
      entry,
      events: eventsFor(candidate, wallet, entry, ctx),
    });
    return { transaction: candidate, idempotentReplay: false };
  }
}

/**
 * replay ou conflito quando já tem transação gravada com a mesma Idempotency-Key ou
 * com o mesmo (providerId, externalTransactionId).
 */
async function resolveDuplicate(
  store: WageringStore,
  candidate: WagerTransaction,
  options: { allowMissing: true },
): Promise<WagerResult | null>;
async function resolveDuplicate(store: WageringStore, candidate: WagerTransaction): Promise<WagerResult>;
async function resolveDuplicate(
  store: WageringStore,
  candidate: WagerTransaction,
  options?: { allowMissing: true },
): Promise<WagerResult | null> {
  const byKey = await store.findByIdempotencyKey(candidate.idempotencyKey);
  if (byKey) {
    if (!byKey.matchesPayload(candidate.payloadHash)) {
      throw new ApplicationError('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key já usada com outro payload', {
        transactionId: byKey.id,
      });
    }
    return { transaction: byKey, idempotentReplay: true };
  }
  const byExternalId = await store.findByExternalId(candidate.providerId, candidate.externalTransactionId);
  if (byExternalId) {
    throw new ApplicationError(
      'EXTERNAL_TRANSACTION_CONFLICT',
      'externalTransactionId já registrado para este provedor com outra Idempotency-Key',
      { transactionId: byExternalId.id },
    );
  }
  if (options?.allowMissing) return null;
  throw new Error(`Duplicidade de ${candidate.idempotencyKey} sem registro vencedor`);
}
