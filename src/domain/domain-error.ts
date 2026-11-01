// Códigos estáveis e legíveis por máquina. Os da lista FAILURE_CODES podem ser gravados
// como failureCode de uma transação; os demais indicam entrada inválida (viram 4xx na API).
export const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS',
  'CURRENCY_MISMATCH',
  'REFERENCE_NOT_A_BET',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_WALLET_MISMATCH',
  'BET_ALREADY_SETTLED',
  'INTERNAL_ERROR',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export type DomainErrorCode =
  | FailureCode
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'INVALID_TRANSACTION'
  | 'INVALID_WALLET'
  | 'INVALID_STATE_TRANSITION';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
