import { Inject, Injectable } from '@nestjs/common';
import type { EventContext } from '../domain/events/integration-event';
import { eventsFor } from '../domain/events/wagering-events';
import { Money, type MoneyProps } from '../domain/money';
import { applyWager } from '../domain/wager-rules';
import { WagerTransaction, type SubmittableKind } from '../domain/wager-transaction';
import { ApplicationError } from './application-error';
import {
  DuplicateTransactionError,
  LockTimeoutError,
  WAGERING_UNIT_OF_WORK,
  type WageringStore,
  type WageringUnitOfWork,
} from './wagering-store';

/** Comando de entrada, igual para HTTP e fila. */
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
  /** true quando a Idempotency-Key já tinha sido gravada e o resultado gravado foi devolvido. */
  idempotentReplay: boolean;
}

/**
 * Caso de uso de submissão de transação, compartilhado pela API e pelo consumidor SQS.
 * Tudo acontece numa transação SQL:
 *
 * 1. SELECT ... FOR UPDATE na carteira. Operações da mesma carteira são serializadas
 *    aqui, em qualquer instância; carteiras diferentes não disputam lock.
 * 2. Com o lock, procura a Idempotency-Key. Em READ COMMITTED cada comando enxerga o
 *    que já foi commitado, então a requisição concorrente com a mesma chave que pegou o
 *    lock antes já está visível: vira replay (mesmo payloadHash) ou conflito.
 * 3. Resolve a referência por (providerId, referenceExternalTransactionId), aplica as
 *    regras (applyWager) e grava transação, saldo, lançamento e eventos no mesmo commit.
 *
 * A mesma chave em paralelo para carteiras diferentes não é serializada pelo lock; o
 * UNIQUE do banco barra o segundo insert e o resultado é decidido relendo o vencedor.
 */
@Injectable()
export class ProcessWagerTransaction {
  constructor(@Inject(WAGERING_UNIT_OF_WORK) private readonly uow: WageringUnitOfWork) {}

  async execute(command: WagerTransactionCommand, ctx: EventContext): Promise<WagerResult> {
    // Valida a forma e calcula o payloadHash antes de abrir transação.
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
    // A referência só é confiável sob lock se for da mesma carteira; applyWager rejeita
    // as de outra carteira antes de usar o estado dela.
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
 * Replay ou conflito diante de uma transação já gravada com a mesma Idempotency-Key ou
 * o mesmo (providerId, externalTransactionId).
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
