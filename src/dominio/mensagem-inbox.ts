import { InvalidTransactionStateError } from './erro-dominio';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

/**
 * registro de que um consumidor já tratou uma mensagem da fila. vai pro banco na mesma
 * transação SQL do efeito financeiro, então "tem linha na inbox" é o mesmo que "o efeito
 * foi commitado". reentrega da mesma mensagem cai aqui e não repete nada.
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | null,
  ) {}

  static receive(props: { messageId: string; consumerName: string; payloadHash: string; receivedAt?: Date }) {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt ?? new Date(), null);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | null {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== null;
  }

  markProcessed(at: Date = new Date()): void {
    if (this.isProcessed()) throw new InvalidTransactionStateError(`Mensagem ${this.messageId} já foi processada`);
    this._processedAt = at < this.receivedAt ? this.receivedAt : at;
  }

  /** mesma mensagem com conteúdo diferente é conflito, não reentrega */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
