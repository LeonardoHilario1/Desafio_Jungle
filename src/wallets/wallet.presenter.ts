import type { Wallet } from '../domain/wallet';

export interface WalletView {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function presentWallet(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance().amount,
    version: wallet.version(),
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt().toISOString(),
  };
}
