import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import { errorCode } from '../../support/domain';

const of = (amount: string, currency: string) => Money.from({ amount, currency });

describe('Money.from', () => {
  test.each([
    ['0', '0.00'],
    ['10', '10.00'],
    ['10.5', '10.50'],
    ['10.05', '10.05'],
    ['0.01', '0.01'],
    ['9999999999999999.99', '9999999999999999.99'],
  ])('normaliza %p para %p', (input, expected) => {
    expect(of(input, 'BRL').amount).toBe(expected);
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
    expect(errorCode(() => of(input, 'BRL'))).toBe('INVALID_AMOUNT');
  });

  test('rejeita number e formato fora de { amount, currency } em tempo de execução', () => {
    expect(errorCode(() => of(10 as unknown as string, 'BRL'))).toBe('INVALID_AMOUNT');
    expect(errorCode(() => Money.from(null as never))).toBe('INVALID_AMOUNT');
    expect(errorCode(() => Money.from('10.00' as never))).toBe('INVALID_AMOUNT');
  });

  test.each(['', 'brl', 'BR', 'BRLX', ' BRL', '123'])('rejeita moeda %p', (currency) => {
    expect(errorCode(() => of('1', currency))).toBe('INVALID_CURRENCY');
  });
});

describe('aritmética', () => {
  test('soma e subtrai sem perda de precisão', () => {
    const a = of('0.10', 'BRL');
    const b = of('0.20', 'BRL');
    expect(a.add(b).amount).toBe('0.30');
    expect(of('100', 'BRL').subtract(of('80', 'BRL')).amount).toBe('20.00');
  });

  test('é imutável: operações devolvem novas instâncias', () => {
    const a = of('5', 'BRL');
    const sum = a.add(of('1', 'BRL'));
    expect(a.amount).toBe('5.00');
    expect(sum.amount).toBe('6.00');
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });

  test('moedas diferentes geram erro', () => {
    const brl = of('1', 'BRL');
    const usd = of('1', 'USD');
    expect(errorCode(() => brl.add(usd))).toBe('CURRENCY_MISMATCH');
    expect(errorCode(() => brl.subtract(usd))).toBe('CURRENCY_MISMATCH');
    expect(errorCode(() => brl.isLessThan(usd))).toBe('CURRENCY_MISMATCH');
    expect(brl.equals(usd)).toBe(false);
  });

  test('valores negativos surgem só por operação, nunca por contrato de entrada', () => {
    const negative = of('1', 'BRL').subtract(of('1.01', 'BRL'));
    expect(negative.amount).toBe('-0.01');
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
    expect(errorCode(() => of('-0.01', 'BRL'))).toBe('INVALID_AMOUNT');
  });

  test('negate inverte o sinal e devolve nova instância', () => {
    const a = of('25', 'BRL');
    expect(a.negate().amount).toBe('-25.00');
    expect(a.negate().negate().equals(a)).toBe(true);
    expect(Money.zero('BRL').negate().isZero()).toBe(true);
    expect(a.amount).toBe('25.00');
  });

  test('isPositive, isNegative e isZero', () => {
    expect(of('0.01', 'BRL').isPositive()).toBe(true);
    expect(of('0', 'BRL').isPositive()).toBe(false);
    expect(of('0', 'BRL').isNegative()).toBe(false);
    expect(of('0.00', 'BRL').isZero()).toBe(true);
  });

  test('escala fixa de 2 casas: sem arredondamento, nunca há terceira casa', () => {
    expect(of('0.1', 'BRL').add(of('0.2', 'BRL')).amount).toBe('0.30');
    expect(errorCode(() => of('0.005', 'BRL'))).toBe('INVALID_AMOUNT');
  });

  test('estouro de numeric(18,2) é rejeitado', () => {
    const max = of('9999999999999999.99', 'BRL');
    expect(errorCode(() => max.add(of('0.01', 'BRL')))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(errorCode(() => max.negate().subtract(of('0.01', 'BRL')))).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('comparação e igualdade', () => {
    expect(of('1', 'BRL').isLessThan(of('1.01', 'BRL'))).toBe(true);
    expect(of('1', 'BRL').equals(of('1.00', 'BRL'))).toBe(true);
    expect(of('1', 'BRL').equals(of('1', 'USD'))).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  test('serializa como string, nunca como number', () => {
    expect(JSON.stringify(of('7.5', 'BRL'))).toBe('{"amount":"7.50","currency":"BRL"}');
    expect(String(of('7.5', 'BRL'))).toBe('7.50 BRL');
  });
});
