import { DomainError } from './domain-error';

/** Formato de Money nos contratos (HTTP, fila e eventos). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Até 2 casas e até 16 dígitos inteiros, o mesmo intervalo de numeric(18,2).
// Sem sinal, sem expoente, sem espaços e sem zeros à esquerda: valores negativos não
// entram por contrato; só surgem internamente por negate/subtract.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_CENTS = 999_999_999_999_999_999n;

/**
 * Valor monetário imutável: toda operação devolve uma nova instância. Internamente
 * guarda centavos em bigint e nunca passa por number. Entrada e saída são strings
 * decimais com escala fixa de 2 casas.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Valida o contrato de entrada: string decimal não negativa com até 2 casas e moeda ISO-4217. */
  static from(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null) {
      throw new DomainError('INVALID_AMOUNT', 'Money deve ser { amount, currency }');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new DomainError('INVALID_AMOUNT', `Valor inválido: ${JSON.stringify(amount)}`);
    }
    const [integer, fraction = ''] = amount.split('.');
    return Money.ofCents(BigInt(`${integer}${fraction.padEnd(2, '0')}`), Money.checkCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.checkCurrency(currency));
  }

  private static ofCents(cents: bigint, currency: string): Money {
    if (cents > MAX_CENTS || cents < -MAX_CENTS) {
      throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Valor fora do intervalo de numeric(18,2)');
    }
    return new Money(cents, currency);
  }

  private static checkCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new DomainError('INVALID_CURRENCY', `Moeda inválida: ${JSON.stringify(currency)}`);
    }
    return currency;
  }

  /** Valor como string decimal com escala 2, por exemplo "10.50" ou "-3.00". */
  get amount(): string {
    const sign = this.cents < 0n ? '-' : '';
    const digits = (this.cents < 0n ? -this.cents : this.cents).toString().padStart(3, '0');
    return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `Moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }
}
