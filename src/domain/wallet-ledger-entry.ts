import { DomainError } from './domain-error';
import type { Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

/**
 * Lançamento imutável do ledger. Só nasce por Wallet.debit/credit, para que toda
 * mudança de saldo tenha exatamente um lançamento. No banco, UPDATE e DELETE são
 * bloqueados (Etapa 3).
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly amount: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {}

  /** Uso interno de Wallet; não chamar diretamente. */
  static record(params: {
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    amount: Money;
    balanceAfter: Money;
  }): WalletLedgerEntry {
    if (params.amount.isZero()) {
      throw new DomainError('INVALID_AMOUNT', 'Lançamento de ledger com valor zero');
    }
    if (params.amount.currency !== params.balanceAfter.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Valor e saldo do lançamento em moedas diferentes');
    }
    return new WalletLedgerEntry(
      crypto.randomUUID(),
      params.walletId,
      params.transactionId,
      params.direction,
      params.amount,
      params.balanceAfter,
      new Date(),
    );
  }
}
