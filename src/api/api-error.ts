export type ApiErrorCode = 'INVALID_REQUEST' | 'IDEMPOTENCY_KEY_REQUIRED' | 'INTERNAL_ERROR';

/** Erro da borda HTTP (forma da requisição), formatado pelo ErrorFilter. */
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
