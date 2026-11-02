import type { Money, MoneyProps } from './dinheiro';

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * resultado da conferência de uma carteira: o saldo gravado contra o saldo que sai do
 * ledger. não corrige nada, só aponta: divergência é coisa pra alguém investigar.
 */
export class Reconciliation {
  private constructor(
    readonly walletId: string,
    readonly storedBalance: Money,
    readonly calculatedBalance: Money,
    readonly checkedEntries: number,
  ) {}

  static of(props: { walletId: string; storedBalance: Money; calculatedBalance: Money; checkedEntries: number }) {
    return new Reconciliation(props.walletId, props.storedBalance, props.calculatedBalance, props.checkedEntries);
  }

  /** gravado - calculado; positivo quer dizer que a carteira tem mais do que o ledger explica */
  get difference(): Money {
    return this.storedBalance.subtract(this.calculatedBalance);
  }

  get consistent(): boolean {
    return this.difference.isZero();
  }

  toJSON(): ReconciliationView {
    return {
      walletId: this.walletId,
      storedBalance: this.storedBalance.toJSON(),
      calculatedBalance: this.calculatedBalance.toJSON(),
      difference: this.difference.toJSON(),
      consistent: this.consistent,
      checkedEntries: this.checkedEntries,
    };
  }
}
