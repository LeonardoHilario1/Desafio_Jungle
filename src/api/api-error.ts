export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'CURRENCY_MISMATCH'
  | 'WALLET_BUSY'
  | 'INTERNAL_ERROR';

/** Erro com status HTTP e código estável, formatado pelo ErrorFilter. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
