import { DomainError } from './domain-error';
import { Money } from './money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

const MAX_PLAYER_ID_LENGTH = 255;

/**
 * Carteira de um jogador em uma moeda. O saldo só muda por debit/credit, que validam
 * a regra, incrementam version e devolvem o lançamento de ledger correspondente.
 * A exclusão mútua entre requisições concorrentes é feita pelo banco
 * (SELECT ... FOR UPDATE), não por esta classe.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(params: { playerId: string; currency: string }): Wallet {
    const playerId = typeof params.playerId === 'string' ? params.playerId.trim() : '';
    if (playerId === '' || playerId.length > MAX_PLAYER_ID_LENGTH) {
      throw new DomainError('INVALID_WALLET', `playerId deve ter de 1 a ${MAX_PLAYER_ID_LENGTH} caracteres`);
    }
    const balance = Money.zero(params.currency);
    const now = new Date();
    return new Wallet(crypto.randomUUID(), playerId, balance.currency, balance, 1, now, now);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(amount: Money): boolean {
    this.assertCurrency(amount);
    return !this._balance.isLessThan(amount);
  }

  debit(amount: Money, transactionId: string): WalletLedgerEntry {
    if (!this.canDebit(amount)) {
      throw new DomainError('INSUFFICIENT_FUNDS', `Saldo ${this._balance} insuficiente para debitar ${amount}`);
    }
    return this.change('DEBIT', amount, this._balance.subtract(amount), transactionId);
  }

  credit(amount: Money, transactionId: string): WalletLedgerEntry {
    this.assertCurrency(amount);
    return this.change('CREDIT', amount, this._balance.add(amount), transactionId);
  }

  private change(
    direction: 'DEBIT' | 'CREDIT',
    amount: Money,
    newBalance: Money,
    transactionId: string,
  ): WalletLedgerEntry {
    // Cria o lançamento antes de alterar o estado: se a validação falhar, a carteira fica intacta.
    const entry = WalletLedgerEntry.record({
      walletId: this.id,
      transactionId,
      direction,
      amount,
      balanceAfter: newBalance,
    });
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = new Date();
    return entry;
  }

  private assertCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `Carteira em ${this.currency}, valor em ${amount.currency}`);
    }
  }
}
