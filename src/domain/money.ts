import { DomainError } from './domain-error';

// Escala 2 e até 16 dígitos inteiros, o mesmo intervalo de numeric(18,2).
// Sem sinal, sem expoente, sem espaços e sem zeros à esquerda.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_CENTS = 999_999_999_999_999_999n;

/**
 * Valor monetário imutável e não negativo. Internamente guarda centavos em bigint;
 * nunca passa por number. Entrada e saída são strings decimais com escala 2.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static of(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new DomainError('INVALID_AMOUNT', `Valor inválido: ${JSON.stringify(amount)}`);
    }
    const [integer, fraction = ''] = amount.split('.');
    return Money.fromCents(BigInt(`${integer}${fraction.padEnd(2, '0')}`), Money.checkCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.checkCurrency(currency));
  }

  private static fromCents(cents: bigint, currency: string): Money {
    if (cents < 0n || cents > MAX_CENTS) {
      throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Valor fora do intervalo de numeric(18,2)');
    }
    return new Money(cents, currency);
  }

  private static checkCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new DomainError('INVALID_CURRENCY', `Moeda inválida: ${JSON.stringify(currency)}`);
    }
    return currency;
  }

  /** Valor como string decimal com escala 2, por exemplo "10.50". */
  get amount(): string {
    const digits = this.cents.toString().padStart(3, '0');
    return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents + other.cents, this.currency);
  }

  /** Lança AMOUNT_OUT_OF_RANGE se o resultado for negativo; quem debita verifica o saldo antes. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents - other.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount, currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `Moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }
}
