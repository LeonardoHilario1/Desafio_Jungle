export type ApplicationErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'TRANSACTION_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_CONFLICT'
  | 'WALLET_BUSY';

/**
 * erro dos casos de uso, sem saber de onde veio a chamada. quem traduz é a borda:
 * o ErrorFilter vira status HTTP, o consumidor SQS decide entre ack, retry ou DLQ.
 * transient = vale a pena tentar de novo com a mesma operação.
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
