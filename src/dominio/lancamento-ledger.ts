import { DomainError } from './erro-dominio';
import { Money } from './dinheiro';

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
  /** version da carteira depois deste lançamento; é o que ordena o ledger de cada carteira */
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = Omit<LedgerEntryState, 'id' | 'createdAt'> & { id?: string; createdAt?: Date };

/**
 * lançamento do ledger, imutável: não tem campo mutável nem método de transição. no banco
 * UPDATE, DELETE e TRUNCATE são barrados por trigger, e um CHECK confere de novo a conta
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

  /** valida o lançamento: valor positivo, saldos não negativos, mesma moeda e conta fechando */
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
    // se as moedas forem diferentes, add/subtract já lançam CURRENCY_MISMATCH
    if (!entry.isBalanced()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'balanceBefore ± money deve ser igual a balanceAfter');
    }
    return entry;
  }

  /** reconstrói a partir do banco, sem revalidar */
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

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === 'CREDIT' ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
