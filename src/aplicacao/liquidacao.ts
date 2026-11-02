import type { EventContext } from '../dominio/eventos/evento-integracao';
import { eventsFor } from '../dominio/eventos/eventos-apostas';
import type { ReferenceRetryPolicy } from '../dominio/politica-referencia';
import { applyWager } from '../dominio/regras-aposta';
import type { WagerTransaction } from '../dominio/transacao-aposta';
import type { Wallet } from '../dominio/carteira';
import type { WageringStore } from './repositorio-apostas';

/** token de injeção da política de retentativa das PENDING_REFERENCE */
export const REFERENCE_RETRY_POLICY = Symbol('REFERENCE_RETRY_POLICY');

// limite da cascata dentro de uma transação SQL; o que passar daqui o worker termina
const MAX_CASCADE_DEPTH = 5;

/**
 * resolve a referência, aplica as regras e grava o resultado. tem que ser chamado com a
 * carteira já travada (lockWallet), na mesma transação SQL.
 *
 * quando a transação termina (PROCESSED, REJECTED), libero na hora as PENDING_REFERENCE
 * da mesma carteira que estavam esperando por ela. assim um REFUND que chegou antes da
 * BET é processado no mesmo commit da BET, sem esperar o worker. dependente de outra
 * carteira fica pro worker, porque eu não tenho o lock dela aqui.
 */
export async function settle(
  store: WageringStore,
  wallet: Wallet,
  tx: WagerTransaction,
  ctx: EventContext,
  policy: ReferenceRetryPolicy,
  now: Date = new Date(),
  depth = 0,
): Promise<void> {
  const reference =
    tx.referenceExternalTransactionId === null
      ? null
      : await store.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
  // a referência só é confiável sob o lock se for da mesma carteira. se for de outra,
  // applyWager rejeita antes de olhar o estado dela
  const referenceAlreadyReversed =
    reference !== null && tx.isReversal() && (await store.hasProcessedReversal(reference.id));

  const outcome = applyWager(wallet, tx, { reference, referenceAlreadyReversed }, now, policy);
  const entry = outcome.status === 'PROCESSED' ? outcome.entry : null;
  // reagendar uma pendência (continua PENDING_REFERENCE) não gera evento de novo
  const wasAlreadyPending = outcome.status === 'PENDING_REFERENCE' && tx.referenceAttempts > 0;
  await store.saveWager({
    wallet,
    transaction: tx,
    entry,
    events: wasAlreadyPending ? [] : eventsFor(tx, wallet, entry, ctx),
  });

  if (tx.isTerminal() && depth < MAX_CASCADE_DEPTH) {
    const dependents = await store.findPendingDependents(wallet.id, tx.providerId, tx.externalTransactionId);
    for (const dependent of dependents) {
      await settle(store, wallet, dependent, { correlationId: dependent.correlationId, causationId: tx.id }, policy, now, depth + 1);
    }
  }
}
