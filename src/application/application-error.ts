export type ApplicationErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'TRANSACTION_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_CONFLICT'
  | 'WALLET_BUSY';

/**
 * Erro dos casos de uso, independente do transporte. A borda traduz: o ErrorFilter
 * para status HTTP, o consumidor SQS para ack, retry ou DLQ.
 * transient indica que repetir a mesma operação pode dar certo.
 */
export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }

  get transient(): boolean {
    return this.code === 'WALLET_BUSY';
  }
}
