import { Inject, Injectable } from '@nestjs/common';
import { Money } from '../dominio/dinheiro';
import { WagerTransaction } from '../dominio/transacao-aposta';
import type { WagerTransactionCommand } from './processar-transacao-aposta';
import { WAGERING_UNIT_OF_WORK, type WageringUnitOfWork } from './repositorio-apostas';

/**
 * grava uma transação FAILED quando uma mensagem da fila esgota as tentativas por falha de
 * infra. é o registro auditável de "isso chegou e não deu pra processar"; a mensagem em si
 * vai pra DLQ.
 *
 * é melhor esforço: se a carteira não existe, se a operação já tem registro (alguma
 * tentativa acabou dando certo) ou se o próprio banco está fora, não grava nada.
 * FAILED é terminal: um reenvio com a mesma Idempotency-Key devolve o FAILED gravado.
 */
@Injectable()
export class RecordPermanentFailure {
  constructor(@Inject(WAGERING_UNIT_OF_WORK) private readonly uow: WageringUnitOfWork) {}

  async execute(command: WagerTransactionCommand, correlationId: string): Promise<WagerTransaction | null> {
    let candidate: WagerTransaction;
    try {
      candidate = WagerTransaction.create({ ...command, money: Money.from(command.money), correlationId });
    } catch {
      return null; // payload inválido não vira transação
    }
    try {
      return await this.uow.run(async (store) => {
        const wallet = await store.lockWallet(candidate.walletId);
        if (!wallet) return null;
        const existing =
          (await store.findByIdempotencyKey(candidate.idempotencyKey)) ??
          (await store.findByExternalId(candidate.providerId, candidate.externalTransactionId));
        if (existing) return null;
        candidate.fail('PROCESSING_FAILED');
        await store.saveWager({ wallet, transaction: candidate, entry: null, events: [] });
        return candidate;
      });
    } catch {
      return null;
    }
  }
}
