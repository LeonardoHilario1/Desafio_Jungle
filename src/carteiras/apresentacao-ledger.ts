import type { MoneyProps } from '../dominio/dinheiro';
import type { WalletLedgerEntry } from '../dominio/lancamento-ledger';
import type { LedgerPage } from '../aplicacao/consultas-apostas';
import { encodeCursor } from '../api/requisicao';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

function presentEntry(e: WalletLedgerEntry): LedgerEntryView {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt.toISOString(),
  };
}

export function presentLedgerPage(page: LedgerPage): LedgerPageView {
  return {
    items: page.items.map(presentEntry),
    nextCursor: page.nextAfterVersion === null ? null : encodeCursor(page.nextAfterVersion),
  };
}
