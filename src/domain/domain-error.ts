/**
 * Códigos estáveis e legíveis por máquina gravados como failureCode de uma transação
 * REJECTED. Cada um diz ao provedor o que fazer (ver ARCHITECTURE.md, "Códigos de falha").
 */
export const FAILURE_CODES = [
  // BET sem saldo suficiente.
  'INSUFFICIENT_FUNDS',
  // Reversão (ROLLBACK de WIN ou REFUND) que deixaria o saldo negativo. Distinto do
  // anterior: o dinheiro já foi creditado e possivelmente sacado; exige ação operacional.
  'REVERSAL_INSUFFICIENT_FUNDS',
  // Moeda da operação diferente da moeda da carteira.
  'CURRENCY_MISMATCH',
  // playerId da operação diferente do dono da carteira.
  'PLAYER_MISMATCH',
  // A referência não chegou dentro do limite de tentativas.
  'REFERENCE_NOT_FOUND',
  // Tipo da referência não permitido (REFUND só de BET; ROLLBACK de BET, WIN ou REFUND).
  'REFERENCE_KIND_NOT_ALLOWED',
  // A referência existe, mas terminou REJECTED ou FAILED.
  'REFERENCE_NOT_PROCESSED',
  // A referência é de outro jogador, carteira, moeda ou rodada.
  'REFERENCE_MISMATCH',
  // Valor da reversão diferente do valor da referência.
  'REFERENCE_AMOUNT_MISMATCH',
  // A referência já foi revertida.
  'REFERENCE_ALREADY_REVERSED',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * Códigos de falha permanente de infraestrutura, gravados em transações FAILED
 * (por exemplo, mensagem da fila que esgotou as tentativas).
 */
export const PERMANENT_FAILURE_CODES = ['PROCESSING_FAILED'] as const;
export type PermanentFailureCode = (typeof PERMANENT_FAILURE_CODES)[number];

export type DomainErrorCode =
  | FailureCode
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'INVALID_TRANSACTION'
  | 'INVALID_WALLET'
  | 'INVALID_LEDGER_ENTRY'
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

/** Transição de estado inválida: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super('INVALID_STATE_TRANSITION', message);
    this.name = 'InvalidTransactionStateError';
  }
}
