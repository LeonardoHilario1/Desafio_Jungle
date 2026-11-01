export type ApiErrorCode = 'INVALID_REQUEST' | 'IDEMPOTENCY_KEY_REQUIRED' | 'INTERNAL_ERROR';

/** erro de formato da requisição (camada HTTP); quem formata é o ErrorFilter */
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
