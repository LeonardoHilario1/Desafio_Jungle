import { DomainError } from './erro-dominio';
import { Money } from './dinheiro';
import { WagerTransaction } from './transacao-aposta';
import { WalletLedgerEntry, type LedgerDirection } from './lancamento-ledger';

const MAX_PLAYER_ID_LENGTH = 255;

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** carteira que acabou de abrir e, se teve saldo inicial, a OPENING e o lançamento dela */
export interface OpenedWallet {
  wallet: Wallet;
  opening: { transaction: WagerTransaction; entry: WalletLedgerEntry } | null;
}

/**
 * aggregate root: a carteira de um jogador numa moeda. o saldo só muda por debit/credit,
 * que sobem a version e devolvem o lançamento do ledger, então saldo e ledger não têm
 * como divergir. a exclusão mútua entre instâncias não é aqui, é do banco
 * (SELECT ... FOR UPDATE).
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

  /**
   * abre com version 1. se o saldo inicial for maior que zero, gera a transação interna
   * OPENING (já PROCESSED) e um lançamento CREDIT de 0 até o saldo inicial. os três
   * precisam ser gravados na mesma transação SQL.
   */
  static open(props: { id?: string; playerId: string; initialBalance: Money; at?: Date }): OpenedWallet {
    const playerId = typeof props.playerId === 'string' ? props.playerId.trim() : '';
    if (playerId === '' || playerId.length > MAX_PLAYER_ID_LENGTH) {
      throw new DomainError('INVALID_WALLET', `playerId deve ter de 1 a ${MAX_PLAYER_ID_LENGTH} caracteres`);
    }
    if (props.initialBalance.isNegative()) {
      throw new DomainError('INVALID_WALLET', 'Saldo inicial não pode ser negativo');
    }
    const at = props.at ?? new Date();
    const wallet = new Wallet(
      props.id ?? crypto.randomUUID(),
      playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
    if (props.initialBalance.isZero()) {
      return { wallet, opening: null };
    }
    const transaction = WagerTransaction.opening({ walletId: wallet.id, playerId, money: props.initialBalance, at });
    const entry = WalletLedgerEntry.create({
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: 'CREDIT',
      money: props.initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, opening: { transaction, entry } };
  }

  /** reconstrói a partir do banco, sem revalidar nada */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
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

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** lança INSUFFICIENT_FUNDS se não tiver saldo; quem decide rejeitar chama canDebit antes */
  debit(money: Money, transactionId: string, at: Date = new Date()): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new DomainError('INSUFFICIENT_FUNDS', `Saldo ${this._balance} insuficiente para debitar ${money}`);
    }
    return this.apply('DEBIT', money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date = new Date()): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply('CREDIT', money, transactionId, at);
  }

  private apply(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    const balanceAfter = direction === 'CREDIT' ? this._balance.add(money) : this._balance.subtract(money);
    // crio o lançamento antes de mexer no estado: se a validação falhar, a carteira fica como estava
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `Carteira em ${this.currency}, valor em ${money.currency}`);
    }
  }
}
