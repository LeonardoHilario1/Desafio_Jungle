import { Inject, Injectable } from '@nestjs/common';
import type { ReferenceRetryPolicy } from '../dominio/politica-referencia';
import type { WagerTransactionStatus } from '../dominio/transacao-aposta';
import { REFERENCE_RETRY_POLICY, settle } from './liquidacao';
import { LockTimeoutError, WAGERING_UNIT_OF_WORK, type WageringUnitOfWork } from './repositorio-apostas';

export interface PendingRunResult {
  /** quantas pendências vencidas foram olhadas */
  checked: number;
  /** viraram PROCESSED */
  processed: number;
  /** viraram REJECTED (inclusive REFERENCE_NOT_FOUND) */
  rejected: number;
  /** continuam esperando, com nova checagem agendada */
  rescheduled: number;
  /** outra instância chegou antes, ou a carteira estava ocupada */
  skipped: number;
}

const BATCH_SIZE = 20;

/**
 * reprocessa as PENDING_REFERENCE com checagem vencida. pode rodar em várias instâncias
 * ao mesmo tempo:
 *
 * - a lista de candidatas sai sem lock nenhum; pra cada uma eu abro uma transação, travo a
 *   carteira (mesma ordem de lock do resto do sistema: carteira primeiro, então sem
 *   deadlock) e releio a transação;
 * - se outra instância já tratou (não está mais pendente ou a checagem foi reagendada pro
 *   futuro), eu pulo.
 *
 * o grosso dos casos nem chega aqui: quando a referência chega na mesma carteira, a
 * pendência é liberada no mesmo commit (settle). o worker cuida do resto: referência que
 * nunca chega (vira REFERENCE_NOT_FOUND depois de maxAttempts) e referência que caiu em
 * outra carteira.
 */
@Injectable()
export class RetryPendingReferences {
  constructor(
    @Inject(WAGERING_UNIT_OF_WORK) private readonly uow: WageringUnitOfWork,
    @Inject(REFERENCE_RETRY_POLICY) private readonly policy: ReferenceRetryPolicy,
  ) {}

  async runOnce(now: Date = new Date()): Promise<PendingRunResult> {
    const candidates = await this.uow.read((store) => store.findDueReferenceChecks(now, BATCH_SIZE));
    const result: PendingRunResult = { checked: candidates.length, processed: 0, rejected: 0, rescheduled: 0, skipped: 0 };

    for (const candidate of candidates) {
      let status: WagerTransactionStatus | 'SKIPPED';
      try {
        status = await this.uow.run(async (store) => {
          const wallet = await store.lockWallet(candidate.walletId);
          const tx = await store.findTransaction(candidate.id);
          if (!wallet || !tx || tx.status !== 'PENDING_REFERENCE' || (tx.nextReferenceCheckAt ?? now) > now) {
            return 'SKIPPED';
          }
          await settle(store, wallet, tx, { correlationId: tx.correlationId, causationId: 'pending-reference-worker' }, this.policy, now);
          // o TS acha que ainda é PENDING_REFERENCE por causa do if acima; settle mudou o estado
          return tx.status as WagerTransactionStatus;
        });
      } catch (error) {
        // carteira ocupada: fica pra próxima volta
        if (!(error instanceof LockTimeoutError)) throw error;
        status = 'SKIPPED';
      }
      if (status === 'PROCESSED') result.processed += 1;
      else if (status === 'REJECTED') result.rejected += 1;
      else if (status === 'PENDING_REFERENCE') result.rescheduled += 1;
      else result.skipped += 1;
    }
    return result;
  }
}
