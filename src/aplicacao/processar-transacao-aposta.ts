import { Inject, Injectable, Logger } from '@nestjs/common';
import { addTrace } from '../observabilidade/contexto';
import { Metrics } from '../observabilidade/metricas';
import type { EventContext } from '../dominio/eventos/evento-integracao';
import { Money, type MoneyProps } from '../dominio/dinheiro';
import { InboxMessage } from '../dominio/mensagem-inbox';
import type { ReferenceRetryPolicy } from '../dominio/politica-referencia';
import { WagerTransaction, type SubmittableKind } from '../dominio/transacao-aposta';
import { ApplicationError } from './erro-aplicacao';
import { REFERENCE_RETRY_POLICY, settle } from './liquidacao';
import {
  DuplicateInboxError,
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
  /** true quando a própria mensagem da fila já estava na inbox (reentrega) */
  duplicateMessage?: boolean;
}

/** dados da mensagem da fila que entram na inbox junto com o efeito */
export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
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
 *    se a transação terminou, as PENDING_REFERENCE que esperavam por ela são liberadas
 *    no mesmo commit (ver settle).
 * 4. vindo da fila, a linha da inbox entra nesse mesmo commit: ou fica tudo, ou nada.
 *
 * obs: a mesma chave em paralelo pra carteiras diferentes o lock não pega. aí quem segura
 * é o UNIQUE do banco, e eu decido a resposta relendo quem ganhou.
 */
@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger(ProcessWagerTransaction.name);

  constructor(
    @Inject(WAGERING_UNIT_OF_WORK) private readonly uow: WageringUnitOfWork,
    @Inject(REFERENCE_RETRY_POLICY) private readonly policy: ReferenceRetryPolicy,
    @Inject(Metrics) private readonly metrics: Metrics = new Metrics(),
  ) {}

  async execute(command: WagerTransactionCommand, ctx: EventContext, inbox?: InboxReceipt): Promise<WagerResult> {
    const source = inbox ? 'sqs' : 'http';
    const started = performance.now();
    addTrace({ walletId: command.walletId, providerId: command.providerId });
    try {
      const result = await this.handle(command, ctx, inbox);
      this.record(result, source, performance.now() - started);
      return result;
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'WALLET_BUSY') {
        this.metrics.inc('wagering_lock_timeouts_total', { source });
        this.logger.warn({ msg: 'carteira ocupada: lock não obtido a tempo', source });
      }
      throw error;
    } finally {
      this.metrics.observe('wagering_processing_duration_seconds', (performance.now() - started) / 1000, { source });
    }
  }

  /** conta e loga o resultado; sem valores de dinheiro no log */
  private record(result: WagerResult, source: string, durationMs: number): void {
    const tx = result.transaction;
    addTrace({ transactionId: tx.id });
    if (result.duplicateMessage) this.metrics.inc('wagering_inbox_duplicates_total');
    else if (result.idempotentReplay) this.metrics.inc('wagering_idempotent_replays_total', { source });
    else this.metrics.inc('wagering_transactions_total', { source, kind: tx.kind, status: tx.status });
    this.logger.log({
      msg: result.idempotentReplay ? 'transação repetida (replay)' : 'transação tratada',
      source,
      kind: tx.kind,
      status: tx.status,
      ...(tx.failureCode !== null && { failureCode: tx.failureCode }),
      idempotentReplay: result.idempotentReplay,
      ...(result.duplicateMessage && { duplicateMessage: true }),
      durationMs: Math.round(durationMs),
    });
  }

  private async handle(command: WagerTransactionCommand, ctx: EventContext, inbox?: InboxReceipt): Promise<WagerResult> {
    // valido a forma e calculo o payloadHash antes de abrir transação
    const candidate = WagerTransaction.create({ ...command, money: Money.from(command.money), correlationId: ctx.correlationId });

    try {
      return await this.uow.run((store) => this.process(store, candidate, ctx, inbox));
    } catch (error) {
      if (error instanceof DuplicateInboxError && inbox) {
        // outro consumidor gravou a mesma mensagem no mesmo instante; o efeito é o dele
        return this.uow.read((store) => resolveInbox(store, inbox)).then((r) => r!);
      }
      if (error instanceof DuplicateTransactionError) {
        return this.uow.read((store) => resolveDuplicate(store, candidate));
      }
      if (error instanceof LockTimeoutError) {
        throw new ApplicationError('WALLET_BUSY', 'Carteira ocupada; tente novamente com a mesma Idempotency-Key');
      }
      throw error;
    }
  }

  private async process(
    store: WageringStore,
    candidate: WagerTransaction,
    ctx: EventContext,
    inbox: InboxReceipt | undefined,
  ): Promise<WagerResult> {
    const wallet = await store.lockWallet(candidate.walletId);
    if (!wallet) {
      throw new ApplicationError('WALLET_NOT_FOUND', `Carteira ${candidate.walletId} não encontrada`);
    }

    if (inbox) {
      const delivered = await resolveInbox(store, inbox);
      if (delivered) return delivered;
    }

    const duplicate = await resolveDuplicate(store, candidate, { allowMissing: true });
    const result = duplicate ?? { transaction: candidate, idempotentReplay: false };
    if (!duplicate) await settle(store, wallet, candidate, ctx, this.policy);

    if (inbox) {
      // marco a mensagem como tratada no mesmo commit, inclusive quando foi replay pela
      // Idempotency-Key (mensagem nova, operação repetida)
      const message = InboxMessage.receive(inbox);
      message.markProcessed();
      await store.insertInbox(message, result.transaction.id);
    }
    return result;
  }
}

/** mensagem já tratada: devolve o resultado gravado; mesmo id com outro conteúdo é conflito */
async function resolveInbox(store: WageringStore, inbox: InboxReceipt): Promise<WagerResult | null> {
  const found = await store.findInbox(inbox.consumerName, inbox.messageId);
  if (!found) return null;
  if (!found.message.matchesPayload(inbox.payloadHash)) {
    throw new ApplicationError('MESSAGE_ID_CONFLICT', `messageId ${inbox.messageId} já recebido com outro conteúdo`);
  }
  const transaction = await store.findTransaction(found.transactionId);
  if (!transaction) throw new Error(`Inbox aponta para transação inexistente ${found.transactionId}`);
  return { transaction, idempotentReplay: true, duplicateMessage: true };
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
