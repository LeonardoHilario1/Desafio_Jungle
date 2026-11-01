import type { IntegrationEvent } from './eventos/evento-integracao';

const MAX_BACKOFF_SECONDS = 300;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

/**
 * evento esperando pra ser publicado. nasce na mesma transação SQL da mudança financeira
 * e o publisher manda pro SQS depois do commit. não coloquei limite de tentativas: evento
 * confirmado não pode se perder, então fica reenviando com backoff até ser aceito.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | null,
    private _publishedAt: Date | null,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
      null,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | null {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === null;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === null || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) return;
    this._publishedAt = at;
    this._nextAttemptAt = null;
  }

  /** soma uma tentativa e agenda a próxima: 2^attempts segundos, no máximo 300 s */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const seconds = Math.min(2 ** this._attempts, MAX_BACKOFF_SECONDS);
    this._nextAttemptAt = new Date(now.getTime() + seconds * 1000);
  }
}
