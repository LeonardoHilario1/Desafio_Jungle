import { DomainError } from './domain-error';
import { Money } from './money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

const MAX_PLAYER_ID_LENGTH = 255;

/**
 * Carteira de um jogador em uma moeda. O saldo só muda por debit/credit, que validam
 * a regra, incrementam version e devolvem o lançamento de ledger correspondente.
 * A exclusão mútua entre requisições concorrentes é feita pelo banco
 * (SELECT ... FOR UPDATE), não por esta classe.
 *
 * O estado mutável fica em campos privados com tipos primitivos (o saldo em string
 * decimal), que é o que o MikroORM persiste; Money é exposto só pelo getter.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private balanceAmount: string,
    private versionNumber: number,
    readonly createdAt: Date,
    private lastUpdatedAt: Date,
  ) {}

  static open(params: { playerId: string; currency: string }): Wallet {
    const playerId = typeof params.playerId === 'string' ? params.playerId.trim() : '';
    if (playerId === '' || playerId.length > MAX_PLAYER_ID_LENGTH) {
      throw new DomainError('INVALID_WALLET', `playerId deve ter de 1 a ${MAX_PLAYER_ID_LENGTH} caracteres`);
    }
    const balance = Money.zero(params.currency);
    const now = new Date();
    return new Wallet(crypto.randomUUID(), playerId, balance.currency, balance.amount, 1, now, now);
  }

  /**
   * Abre a carteira já com saldo. O saldo inicial entra no ledger como lançamento de
   * abertura, que deve ser gravado junto com a carteira.
   */
  static openWithBalance(params: { playerId: string; initialBalance: Money }): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry;
  } {
    const wallet = Wallet.open({ playerId: params.playerId, currency: params.initialBalance.currency });
    const openingEntry = wallet.change('CREDIT', params.initialBalance, params.initialBalance, null);
    return { wallet, openingEntry };
  }

  balance(): Money {
    return Money.of(this.balanceAmount, this.currency);
  }

  version(): number {
    return this.versionNumber;
  }

  updatedAt(): Date {
    return this.lastUpdatedAt;
  }

  canDebit(amount: Money): boolean {
    this.assertCurrency(amount);
    return !this.balance().isLessThan(amount);
  }

  debit(amount: Money, transactionId: string): WalletLedgerEntry {
    if (!this.canDebit(amount)) {
      throw new DomainError('INSUFFICIENT_FUNDS', `Saldo ${this.balance()} insuficiente para debitar ${amount}`);
    }
    return this.change('DEBIT', amount, this.balance().subtract(amount), transactionId);
  }

  credit(amount: Money, transactionId: string): WalletLedgerEntry {
    this.assertCurrency(amount);
    return this.change('CREDIT', amount, this.balance().add(amount), transactionId);
  }

  private change(
    direction: 'DEBIT' | 'CREDIT',
    amount: Money,
    newBalance: Money,
    transactionId: string | null,
  ): WalletLedgerEntry {
    // Cria o lançamento antes de alterar o estado: se a validação falhar, a carteira fica intacta.
    const entry = WalletLedgerEntry.record({
      walletId: this.id,
      transactionId,
      direction,
      amount,
      balanceAfter: newBalance,
    });
    this.balanceAmount = newBalance.amount;
    this.versionNumber += 1;
    this.lastUpdatedAt = new Date();
    return entry;
  }

  private assertCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `Carteira em ${this.currency}, valor em ${amount.currency}`);
    }
  }
}
