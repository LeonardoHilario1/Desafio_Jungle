import { DomainError, type FailureCode } from './domain-error';
import type { Money } from './money';
import { sha256Hex } from './payload-hash';

export const WAGER_TYPES = ['BET', 'WIN', 'LOSS'] as const;
export type WagerType = (typeof WAGER_TYPES)[number];

export const TRANSACTION_STATUSES = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

const TERMINAL_STATUSES: readonly TransactionStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];
const MAX_KEY_LENGTH = 255;

export interface ReceiveTransactionParams {
  idempotencyKey: string;
  walletId: string;
  type: WagerType;
  amount: Money;
  /** Chave de idempotência da BET que uma WIN ou LOSS liquida. Proibida em BET. */
  referenceKey: string | null;
}

/**
 * Transação recebida de um provedor. Regras de forma:
 * - BET: valor > 0, sem referência; debita a carteira.
 * - WIN: valor > 0, referencia uma BET; credita a carteira.
 * - LOSS: valor 0.00, referencia uma BET; não move dinheiro, só liquida a aposta.
 *
 * Estados: PENDING e PENDING_REFERENCE são abertos; PROCESSED, REJECTED e FAILED
 * são terminais e não mudam mais.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly type: WagerType,
    readonly amount: Money,
    readonly referenceKey: string | null,
    private _referenceTransactionId: string | null,
    private _status: TransactionStatus,
    private _failureCode: FailureCode | null,
    readonly createdAt: Date,
    private _processedAt: Date | null,
  ) {}

  static receive(params: ReceiveTransactionParams): WagerTransaction {
    const idempotencyKey = requireKey(params.idempotencyKey, 'idempotencyKey');
    const walletId = requireKey(params.walletId, 'walletId');
    if (!WAGER_TYPES.includes(params.type)) {
      throw new DomainError('INVALID_TRANSACTION', `Tipo de transação inválido: ${JSON.stringify(params.type)}`);
    }

    const referenceKey = params.referenceKey === null ? null : requireKey(params.referenceKey, 'referenceKey');
    if (params.type === 'BET' && referenceKey !== null) {
      throw new DomainError('INVALID_TRANSACTION', 'BET não pode ter referenceKey');
    }
    if (params.type !== 'BET' && referenceKey === null) {
      throw new DomainError('INVALID_TRANSACTION', `${params.type} exige referenceKey da BET liquidada`);
    }
    if (params.type === 'LOSS' && !params.amount.isZero()) {
      throw new DomainError('INVALID_TRANSACTION', 'LOSS deve ter valor 0.00');
    }
    if (params.type !== 'LOSS' && params.amount.isZero()) {
      throw new DomainError('INVALID_TRANSACTION', `${params.type} deve ter valor maior que zero`);
    }

    return new WagerTransaction(
      crypto.randomUUID(),
      idempotencyKey,
      WagerTransaction.hashPayload({ walletId, type: params.type, amount: params.amount, referenceKey }),
      walletId,
      params.type,
      params.amount,
      referenceKey,
      null,
      'PENDING',
      null,
      new Date(),
      null,
    );
  }

  /**
   * SHA-256 do JSON canônico dos campos de negócio. A chave de idempotência fica de
   * fora (ela é a identidade, não o conteúdo). O valor entra normalizado, então
   * "10" e "10.00" geram o mesmo hash.
   */
  static hashPayload(p: { walletId: string; type: WagerType; amount: Money; referenceKey: string | null }): string {
    return sha256Hex({
      walletId: p.walletId,
      type: p.type,
      amount: p.amount.amount,
      currency: p.amount.currency,
      referenceKey: p.referenceKey,
    });
  }

  get status(): TransactionStatus {
    return this._status;
  }

  get failureCode(): FailureCode | null {
    return this._failureCode;
  }

  get referenceTransactionId(): string | null {
    return this._referenceTransactionId;
  }

  get processedAt(): Date | null {
    return this._processedAt;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /**
   * Valida se esta WIN/LOSS pode liquidar a BET informada e, se puder, guarda o vínculo.
   * Devolve o failureCode quando não pode. "Já liquidada" depende de outras linhas e
   * é garantido pelo índice único do banco, não aqui.
   */
  linkReference(bet: WagerTransaction): FailureCode | null {
    this.assertOpen();
    if (this.type === 'BET') {
      throw new DomainError('INVALID_TRANSACTION', 'BET não referencia outra transação');
    }
    if (bet.idempotencyKey !== this.referenceKey) {
      throw new DomainError('INVALID_TRANSACTION', 'Transação informada não é a referenciada');
    }
    if (bet.type !== 'BET') return 'REFERENCE_NOT_A_BET';
    if (bet.walletId !== this.walletId) return 'REFERENCE_WALLET_MISMATCH';
    if (bet.amount.currency !== this.amount.currency) return 'CURRENCY_MISMATCH';
    if (bet.status !== 'PROCESSED') return 'REFERENCE_NOT_PROCESSED';
    this._referenceTransactionId = bet.id;
    return null;
  }

  awaitReference(): void {
    if (this._status !== 'PENDING' || this.type === 'BET') {
      throw new DomainError('INVALID_STATE_TRANSITION', `${this.type} em ${this._status} não pode aguardar referência`);
    }
    this._status = 'PENDING_REFERENCE';
  }

  markProcessed(): void {
    if (this.type !== 'BET' && this._referenceTransactionId === null) {
      throw new DomainError('INVALID_STATE_TRANSITION', `${this.type} só é processada depois de vinculada à BET`);
    }
    this.finish('PROCESSED', null);
  }

  reject(code: FailureCode): void {
    this.finish('REJECTED', code);
  }

  fail(code: FailureCode): void {
    this.finish('FAILED', code);
  }

  private finish(status: TransactionStatus, failureCode: FailureCode | null): void {
    this.assertOpen();
    this._status = status;
    this._failureCode = failureCode;
    this._processedAt = new Date();
  }

  private assertOpen(): void {
    if (this.isTerminal()) {
      throw new DomainError('INVALID_STATE_TRANSITION', `Transação já está em estado terminal (${this._status})`);
    }
  }
}

function requireKey(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_KEY_LENGTH) {
    throw new DomainError('INVALID_TRANSACTION', `${field} deve ter de 1 a ${MAX_KEY_LENGTH} caracteres`);
  }
  return value;
}
