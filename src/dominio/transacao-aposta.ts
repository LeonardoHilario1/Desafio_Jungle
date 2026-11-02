import {
  DomainError,
  InvalidTransactionStateError,
  type FailureCode,
  type PermanentFailureCode,
} from './erro-dominio';
import { Money } from './dinheiro';
import { sha256Hex } from './hash-payload';
import type { LedgerDirection } from './lancamento-ledger';

export const WAGER_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerTransactionKind = (typeof WAGER_KINDS)[number];

/** tipos que a API e a fila aceitam. OPENING é só interno */
export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

export const TRANSACTION_STATUSES = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const;
export type WagerTransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export type TransactionFailureCode = FailureCode | PermanentFailureCode;

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];
const MAX_TEXT_LENGTH = 255;

/** provedor reservado pras transações internas OPENING */
export const INTERNAL_PROVIDER_ID = 'internal';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: Money;
  /** id da transação referenciada no provedor, não o nosso id interno */
  referenceExternalTransactionId: string | null;
  correlationId: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | null;
  failureCode: TransactionFailureCode | null;
  processedAt: Date | null;
  /** saldo da carteira que a transação viu quando chegou no estado atual */
  observedBalance: Money | null;
  /** quantas vezes o worker já procurou a referência sem achar */
  referenceAttempts: number;
  /** quando procurar a referência de novo; só em PENDING_REFERENCE */
  nextReferenceCheckAt: Date | null;
}

export interface CreateWagerTransactionProps {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  referenceExternalTransactionId: string | null;
  correlationId?: string;
}

/** campos de negócio que entram no payloadHash */
export type PayloadFields = Omit<CreateWagerTransactionProps, 'idempotencyKey' | 'correlationId'>;

/**
 * transação que chega do provedor (ou a OPENING, interna).
 *
 * forma (validada no create):
 * - BET: valor > 0, sem referência.
 * - WIN: valor > 0, referência opcional (a BET da rodada).
 * - LOSS: valor >= 0, referência opcional; não mexe no saldo.
 * - REFUND e ROLLBACK: valor > 0, referência obrigatória.
 *
 * transições:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED
 * PROCESSED, REJECTED e FAILED são terminais; tentar sair deles lança
 * InvalidTransactionStateError, porque aí é bug.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | null,
    readonly gameId: string | null,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | null,
    readonly correlationId: string,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | null,
    private _failureCode: TransactionFailureCode | null,
    private _processedAt: Date | null,
    private _observedBalance: Money | null,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | null,
  ) {}

  /** nasce em PENDING. valida a forma e se a referência é exigida pro kind */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new DomainError('INVALID_TRANSACTION', `kind inválido: ${JSON.stringify(props.kind)}`);
    }
    const fields: PayloadFields = {
      providerId: requireText(props.providerId, 'providerId'),
      externalTransactionId: requireText(props.externalTransactionId, 'externalTransactionId'),
      walletId: requireText(props.walletId, 'walletId'),
      playerId: requireText(props.playerId, 'playerId'),
      roundId: requireText(props.roundId, 'roundId'),
      gameId: requireText(props.gameId, 'gameId'),
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId:
        props.referenceExternalTransactionId === null
          ? null
          : requireText(props.referenceExternalTransactionId, 'referenceExternalTransactionId'),
    };
    assertShape(fields);

    return new WagerTransaction(
      crypto.randomUUID(),
      fields.providerId,
      fields.externalTransactionId,
      requireText(props.idempotencyKey, 'idempotencyKey'),
      WagerTransaction.hashPayload(fields),
      fields.walletId,
      fields.playerId,
      fields.roundId,
      fields.gameId,
      fields.kind,
      fields.money,
      fields.referenceExternalTransactionId,
      props.correlationId ?? crypto.randomUUID(),
      new Date(),
      'PENDING',
      null,
      null,
      null,
      null,
      0,
      null,
    );
  }

  /** transação interna de abertura, já PROCESSED. só o Wallet.open usa */
  static opening(props: { walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new DomainError('INVALID_TRANSACTION', 'OPENING deve ter valor maior que zero');
    }
    const externalTransactionId = `opening:${props.walletId}`;
    return new WagerTransaction(
      crypto.randomUUID(),
      INTERNAL_PROVIDER_ID,
      externalTransactionId,
      `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
      sha256Hex({ walletId: props.walletId, kind: 'OPENING', amount: props.money.amount, currency: props.money.currency }),
      props.walletId,
      props.playerId,
      null,
      null,
      'OPENING',
      props.money,
      null,
      crypto.randomUUID(),
      props.at,
      'PROCESSED',
      null,
      null,
      props.at,
      props.money,
      0,
      null,
    );
  }

  /** reconstrói a partir do banco, sem revalidar forma nem transição */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
    );
  }

  /**
   * SHA-256 do JSON canônico (chaves ordenadas, sem espaço) dos campos de negócio.
   * deixo de fora a Idempotency-Key, o correlationId e coisa de transporte. o valor entra
   * normalizado, então "10" e "10.00" dão o mesmo hash.
   */
  static hashPayload(fields: PayloadFields): string {
    return sha256Hex({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      walletId: fields.walletId,
      playerId: fields.playerId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: { amount: fields.money.amount, currency: fields.money.currency },
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | null {
    return this._referenceTransactionId;
  }

  get failureCode(): TransactionFailureCode | null {
    return this._failureCode;
  }

  get processedAt(): Date | null {
    return this._processedAt;
  }

  get observedBalance(): Money | null {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | null {
    return this._nextReferenceCheckAt;
  }

  // ---- transições

  /** se a transação informou referência, o referenceTransactionId é obrigatório */
  markProcessed(referenceTransactionId: string | null, observedBalance: Money, at: Date = new Date()): void {
    this.assertOpen();
    if ((this.referenceExternalTransactionId !== null) !== (referenceTransactionId !== null)) {
      throw new InvalidTransactionStateError(`${this.kind} processada com vínculo de referência inconsistente`);
    }
    this._referenceTransactionId = referenceTransactionId;
    this.finish('PROCESSED', null, observedBalance, at);
  }

  /** nextCheckAt: quando o worker deve procurar a referência de novo */
  markPendingReference(observedBalance: Money, nextCheckAt: Date): void {
    if (this._status !== 'PENDING') {
      throw new InvalidTransactionStateError(`Transação em ${this._status} não pode passar a PENDING_REFERENCE`);
    }
    if (this.referenceExternalTransactionId === null) {
      throw new InvalidTransactionStateError(`${this.kind} sem referência não aguarda referência`);
    }
    this._status = 'PENDING_REFERENCE';
    this._observedBalance = observedBalance;
    this._referenceAttempts = 0;
    this._nextReferenceCheckAt = nextCheckAt;
  }

  /** mais uma tentativa sem achar a referência; continua em PENDING_REFERENCE */
  scheduleReferenceRetry(nextCheckAt: Date): void {
    if (this._status !== 'PENDING_REFERENCE') {
      throw new InvalidTransactionStateError(`Transação em ${this._status} não está aguardando referência`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = nextCheckAt;
  }

  reject(code: FailureCode, observedBalance: Money, at: Date = new Date()): void {
    this.finish('REJECTED', code, observedBalance, at);
  }

  fail(code: PermanentFailureCode, at: Date = new Date()): void {
    this.finish('FAILED', code, this._observedBalance, at);
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }

  requiresReference(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** direção do lançamento. no ROLLBACK é o inverso da referência */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case 'OPENING':
      case 'WIN':
      case 'REFUND':
        return 'CREDIT';
      case 'BET':
        return 'DEBIT';
      case 'ROLLBACK':
        if (!reference) throw new InvalidTransactionStateError('ROLLBACK precisa da referência para definir a direção');
        return reference.ledgerDirectionFor() === 'CREDIT' ? 'DEBIT' : 'CREDIT';
      case 'LOSS':
        throw new InvalidTransactionStateError('LOSS não gera lançamento');
    }
  }

  private finish(
    status: WagerTransactionStatus,
    failureCode: TransactionFailureCode | null,
    observedBalance: Money | null,
    at: Date,
  ): void {
    this.assertOpen();
    this._status = status;
    this._failureCode = failureCode;
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this._nextReferenceCheckAt = null;
  }

  private assertOpen(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Transação ${this.id} já está em estado terminal (${this._status})`);
    }
  }
}

function assertShape(f: PayloadFields): void {
  const hasReference = f.referenceExternalTransactionId !== null;
  if (f.kind === 'BET' && hasReference) {
    throw new DomainError('INVALID_TRANSACTION', 'BET não referencia outra transação');
  }
  if ((f.kind === 'REFUND' || f.kind === 'ROLLBACK') && !hasReference) {
    throw new DomainError('INVALID_TRANSACTION', `${f.kind} exige referenceExternalTransactionId`);
  }
  if (f.referenceExternalTransactionId === f.externalTransactionId) {
    throw new DomainError('INVALID_TRANSACTION', 'Transação não pode referenciar a si mesma');
  }
  if (f.kind === 'LOSS' ? f.money.isNegative() : !f.money.isPositive()) {
    throw new DomainError('INVALID_TRANSACTION', `${f.kind} deve ter valor ${f.kind === 'LOSS' ? '>= 0' : '> 0'}`);
  }
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) {
    throw new DomainError('INVALID_TRANSACTION', `${field} deve ter de 1 a ${MAX_TEXT_LENGTH} caracteres`);
  }
  return value;
}
