import { DomainError } from './domain-error';
import { Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

/** TRANSACTION: efeito de uma transação de aposta. OPENING: saldo inicial da carteira. */
export type LedgerEntryKind = 'TRANSACTION' | 'OPENING';

/**
 * Lançamento imutável do ledger. Só nasce por Wallet.debit/credit, para que toda
 * mudança de saldo tenha exatamente um lançamento. No banco, UPDATE, DELETE e
 * TRUNCATE são bloqueados por trigger.
 *
 * O lançamento de abertura (OPENING) registra o saldo inicial: é sempre CREDIT e não
 * tem transação de aposta, o que mantém saldo = soma do ledger desde o primeiro dia.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly kind: LedgerEntryKind,
    readonly transactionId: string | null,
    readonly direction: LedgerDirection,
    readonly currency: string,
    private readonly amountValue: string,
    private readonly balanceAfterValue: string,
    readonly createdAt: Date,
  ) {}

  /** Uso interno de Wallet; não chamar diretamente. */
  static record(params: {
    walletId: string;
    /** null apenas no lançamento de abertura. */
    transactionId: string | null;
    direction: LedgerDirection;
    amount: Money;
    balanceAfter: Money;
  }): WalletLedgerEntry {
    if (params.amount.isZero()) {
      throw new DomainError('INVALID_AMOUNT', 'Lançamento de ledger com valor zero');
    }
    const kind: LedgerEntryKind = params.transactionId === null ? 'OPENING' : 'TRANSACTION';
    if (kind === 'OPENING' && params.direction !== 'CREDIT') {
      throw new DomainError('INVALID_AMOUNT', 'Lançamento de abertura deve ser CREDIT');
    }
    if (params.amount.currency !== params.balanceAfter.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Valor e saldo do lançamento em moedas diferentes');
    }
    return new WalletLedgerEntry(
      crypto.randomUUID(),
      params.walletId,
      kind,
      params.transactionId,
      params.direction,
      params.amount.currency,
      params.amount.amount,
      params.balanceAfter.amount,
      new Date(),
    );
  }

  amount(): Money {
    return Money.of(this.amountValue, this.currency);
  }

  balanceAfter(): Money {
    return Money.of(this.balanceAfterValue, this.currency);
  }
}
