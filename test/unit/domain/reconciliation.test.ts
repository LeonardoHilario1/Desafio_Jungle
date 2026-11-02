import { expect, test } from 'bun:test';
import { Reconciliation } from '../../../src/dominio/reconciliacao';
import { brl } from '../../support/domain';

test('diferença é gravado - calculado; consistente só com diferença zero', () => {
  const ok = Reconciliation.of({ walletId: 'w', storedBalance: brl('10'), calculatedBalance: brl('10'), checkedEntries: 3 });
  expect(ok.consistent).toBe(true);
  expect(ok.toJSON()).toMatchObject({ difference: { amount: '0.00', currency: 'BRL' }, checkedEntries: 3 });

  const off = Reconciliation.of({ walletId: 'w', storedBalance: brl('12.50'), calculatedBalance: brl('10'), checkedEntries: 3 });
  expect(off.consistent).toBe(false);
  expect(off.difference.amount).toBe('2.50');
});
