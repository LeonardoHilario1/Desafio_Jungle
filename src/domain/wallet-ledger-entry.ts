import { DomainError } from './domain-error';
import { Money } from './money';

export const LEDGER_DIRECTIONS = ['DEBIT', 'CREDIT'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** version da carteira depois deste lançamento; ordena o ledger de cada carteira. */
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = Omit<LedgerEntryState, 'id' | 'createdAt'> & { id?: string; createdAt?: Date };

/**
 * Lançamento imutável do ledger: sem campos mutáveis nem métodos de transição. No banco,
 * UPDATE, DELETE e TRUNCATE são bloqueados por trigger, e um CHECK repete a aritmética
 * balance_before ± amount = balance_after.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida o lançamento: valor positivo, saldos não negativos, mesma moeda e aritmética fechada. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate({
      ...props,
      id: props.id ?? crypto.randomUUID(),
      createdAt: props.createdAt ?? new Date(),
    });
    if (!LEDGER_DIRECTIONS.includes(entry.direction)) {
      throw new DomainError('INVALID_LEDGER_ENTRY', `Direção inválida: ${entry.direction}`);
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'walletVersion deve ser inteiro >= 1');
    }
    if (!entry.money.isPositive()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Lançamento deve ter valor maior que zero');
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Lançamento não pode deixar saldo negativo');
    }
    // add/subtract lançam CURRENCY_MISMATCH se as moedas divergirem.
    if (!entry.isBalanced()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'balanceBefore ± money deve ser igual a balanceAfter');
    }
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === 'CREDIT' ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
