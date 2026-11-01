import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../src/domain/domain-error';
import { Money } from '../../../src/domain/money';

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

describe('Money.of', () => {
  test.each([
    ['0', '0.00'],
    ['10', '10.00'],
    ['10.5', '10.50'],
    ['10.05', '10.05'],
    ['0.01', '0.01'],
    ['9999999999999999.99', '9999999999999999.99'],
  ])('normaliza %p para %p', (input, expected) => {
    expect(Money.of(input, 'BRL').amount).toBe(expected);
  });

  test.each([
    '',
    ' 10',
    '10 ',
    '-1',
    '+1',
    '1.234',
    '1.',
    '.5',
    '01',
    '1e3',
    '1,50',
    'NaN',
    'Infinity',
    '0x10',
    '10000000000000000',
  ])('rejeita %p', (input) => {
    expect(errorCode(() => Money.of(input, 'BRL'))).toBe('INVALID_AMOUNT');
  });

  test('rejeita number em tempo de execução', () => {
    expect(errorCode(() => Money.of(10 as unknown as string, 'BRL'))).toBe('INVALID_AMOUNT');
  });

  test.each(['', 'brl', 'BR', 'BRLX', ' BRL', '123'])('rejeita moeda %p', (currency) => {
    expect(errorCode(() => Money.of('1', currency))).toBe('INVALID_CURRENCY');
  });
});

describe('aritmética', () => {
  test('soma e subtrai sem perda de precisão', () => {
    const a = Money.of('0.10', 'BRL');
    const b = Money.of('0.20', 'BRL');
    expect(a.add(b).amount).toBe('0.30');
    expect(Money.of('100', 'BRL').subtract(Money.of('80', 'BRL')).amount).toBe('20.00');
  });

  test('é imutável: operações devolvem novas instâncias', () => {
    const a = Money.of('5', 'BRL');
    const sum = a.add(Money.of('1', 'BRL'));
    expect(a.amount).toBe('5.00');
    expect(sum.amount).toBe('6.00');
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });

  test('moedas diferentes geram erro', () => {
    const brl = Money.of('1', 'BRL');
    const usd = Money.of('1', 'USD');
    expect(errorCode(() => brl.add(usd))).toBe('CURRENCY_MISMATCH');
    expect(errorCode(() => brl.subtract(usd))).toBe('CURRENCY_MISMATCH');
    expect(errorCode(() => brl.isLessThan(usd))).toBe('CURRENCY_MISMATCH');
  });

  test('resultado negativo é rejeitado', () => {
    expect(errorCode(() => Money.of('1', 'BRL').subtract(Money.of('1.01', 'BRL')))).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('estouro de numeric(18,2) é rejeitado', () => {
    const max = Money.of('9999999999999999.99', 'BRL');
    expect(errorCode(() => max.add(Money.of('0.01', 'BRL')))).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('comparação e igualdade', () => {
    expect(Money.of('1', 'BRL').isLessThan(Money.of('1.01', 'BRL'))).toBe(true);
    expect(Money.of('1', 'BRL').equals(Money.of('1.00', 'BRL'))).toBe(true);
    expect(Money.of('1', 'BRL').equals(Money.of('1', 'USD'))).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  test('serializa como string, nunca como number', () => {
    expect(JSON.stringify(Money.of('7.5', 'BRL'))).toBe('{"amount":"7.50","currency":"BRL"}');
    expect(String(Money.of('7.5', 'BRL'))).toBe('7.50 BRL');
  });
});
