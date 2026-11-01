/**
 * códigos estáveis (pensados pra máquina ler) que vão no failureCode de uma transação
 * REJECTED. cada um diz pro provedor o que fazer (tabela no ARCHITECTURE.md, "Códigos de falha").
 */
export const FAILURE_CODES = [
  // BET sem saldo
  'INSUFFICIENT_FUNDS',
  // reversão (ROLLBACK de WIN ou REFUND) que deixaria saldo negativo. separei do de cima
  // porque é outra situação: o dinheiro já foi creditado e talvez sacado, precisa de alguém olhar
  'REVERSAL_INSUFFICIENT_FUNDS',
  // moeda da operação diferente da moeda da carteira
  'CURRENCY_MISMATCH',
  // playerId da operação não é o dono da carteira
  'PLAYER_MISMATCH',
  // a referência não chegou dentro do limite de tentativas
  'REFERENCE_NOT_FOUND',
  // tipo de referência não permitido (REFUND só de BET; ROLLBACK de BET, WIN ou REFUND)
  'REFERENCE_KIND_NOT_ALLOWED',
  // a referência existe, mas terminou REJECTED ou FAILED
  'REFERENCE_NOT_PROCESSED',
  // a referência é de outro jogador, carteira, moeda ou rodada
  'REFERENCE_MISMATCH',
  // valor da reversão diferente do valor da referência
  'REFERENCE_AMOUNT_MISMATCH',
  // essa referência já foi revertida
  'REFERENCE_ALREADY_REVERSED',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * códigos de falha permanente de infra, que vão em transações FAILED
 * (ex.: mensagem da fila que esgotou as tentativas).
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

/** transição de estado inválida: isso é bug, não caminho de negócio */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super('INVALID_STATE_TRANSITION', message);
    this.name = 'InvalidTransactionStateError';
  }
}
