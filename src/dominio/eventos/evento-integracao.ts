import { createHash } from 'node:crypto';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** contexto de rastreio que vem da entrada (HTTP ou fila) e vai pros eventos */
export interface EventContext {
  correlationId: string;
  causationId?: string;
}

/**
 * envelope dos eventos de integração. eventType e version ficam no tipo concreto, não
 * espalhados como string no código que dispara. data só leva valor JSON estável
 * (MoneyProps, nunca Money), pra dar pra versionar o payload.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** envelope serializado que vai pro payload da outbox */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined && { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

/**
 * UUID determinístico (formato v8) gerado a partir de um nome. uso como eventId: o mesmo
 * fato (transação + tipo de evento) sempre tem o mesmo id, então a PK da outbox não deixa
 * gravar duas vezes e o consumidor consegue deduplicar republicação pelo eventId.
 */
export function deterministicEventId(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
