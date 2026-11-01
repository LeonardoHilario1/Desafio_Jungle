import { DomainError } from '../../src/domain/domain-error';
import { Money } from '../../src/domain/money';
import type { CreateWagerTransactionProps } from '../../src/domain/wager-transaction';

/** Código do DomainError lançado por fn, ou undefined se não lançou. */
export function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

/** Props válidas de uma BET; os testes sobrescrevem só o que importa. */
export function txProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    idempotencyKey: 'provider-a:tx-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('10'),
    referenceExternalTransactionId: null,
    ...overrides,
  };
}
