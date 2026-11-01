import { expect } from 'bun:test';
import type { ApiResponse, TestApi } from './api';

export const PROVIDER = 'provider-a';

export interface TestWallet {
  id: string;
  playerId: string;
  currency: string;
}

/** Cria carteira pela API com saldo inicial (em BRL por padrão). */
export async function createWallet(
  api: TestApi,
  amount = '100.00',
  options: { currency?: string; playerId?: string } = {},
): Promise<TestWallet> {
  const playerId = options.playerId ?? crypto.randomUUID();
  const currency = options.currency ?? 'BRL';
  const res = await api.post('/wallets', { playerId, initialBalance: { amount, currency } });
  expect(res.status).toBe(201);
  return { id: res.body.id, playerId, currency };
}

export type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface TxOptions {
  externalTransactionId?: string;
  reference?: string;
  roundId?: string;
  currency?: string;
  providerId?: string;
  playerId?: string;
}

/** Corpo do POST /wagering/transactions no formato do desafio. */
export function txBody(wallet: TestWallet, kind: Kind, amount: string, options: TxOptions = {}): Record<string, unknown> {
  return {
    providerId: options.providerId ?? PROVIDER,
    externalTransactionId: options.externalTransactionId ?? `tx-${crypto.randomUUID()}`,
    playerId: options.playerId ?? wallet.playerId,
    walletId: wallet.id,
    roundId: options.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: options.currency ?? wallet.currency },
    ...(options.reference !== undefined && { referenceExternalTransactionId: options.reference }),
  };
}

/** Envia com Idempotency-Key "{providerId}:{externalTransactionId}", salvo outra informada. */
export function submit(api: TestApi, body: Record<string, unknown>, key?: string | null): Promise<ApiResponse> {
  const idempotencyKey = key === undefined ? `${body.providerId}:${body.externalTransactionId}` : key;
  return api.post('/wagering/transactions', body, idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey });
}

export async function balanceOf(api: TestApi, walletId: string): Promise<string> {
  return (await api.get(`/wallets/${walletId}`)).body.balance.amount;
}
