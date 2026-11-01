import { describe, expect, test } from 'bun:test';
import { deterministicEventId } from '../../../src/dominio/eventos/evento-integracao';
import { eventsFor, WalletBalanceChanged } from '../../../src/dominio/eventos/eventos-apostas';
import { OutboxMessage } from '../../../src/dominio/mensagem-outbox';
import { applyWager } from '../../../src/dominio/regras-aposta';
import { WagerTransaction } from '../../../src/dominio/transacao-aposta';
import { Wallet } from '../../../src/dominio/carteira';
import { brl, txProps } from '../../support/domain';

const ctx = { correlationId: 'corr-1', causationId: 'provider-a:tx-1' };

function processedBet() {
  const wallet = Wallet.open({ playerId: 'player-1', initialBalance: brl('100') }).wallet;
  const bet = WagerTransaction.create(txProps({ walletId: wallet.id, money: brl('25') }));
  const outcome = applyWager(wallet, bet, { reference: null, referenceAlreadyReversed: false });
  return { wallet, bet, entry: outcome.status === 'PROCESSED' ? outcome.entry : null };
}

describe('IntegrationEvent', () => {
  test('transação processada gera WagerTransactionProcessed e WalletBalanceChanged', () => {
    const { wallet, bet, entry } = processedBet();
    const events = eventsFor(bet, wallet, entry, ctx);
    expect(events.map((e) => e.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events[1]).toBeInstanceOf(WalletBalanceChanged);
    expect(events[1]!.aggregateId).toBe(wallet.id);
    expect(events[0]!.aggregateId).toBe(bet.id);
  });

  test('envelope serializado: ISO-8601, version, correlationId e MoneyProps em string', () => {
    const { wallet, bet, entry } = processedBet();
    const json = WalletBalanceChanged.from(wallet, entry!, bet, ctx).toJSON();
    expect(json).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'provider-a:tx-1',
      data: {
        walletId: wallet.id,
        transactionId: bet.id,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(json.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // JSON estável: nenhuma instância de Money vaza para o payload.
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('eventId é determinístico por (transação, tipo): o mesmo fato tem sempre o mesmo id', () => {
    const { wallet, bet, entry } = processedBet();
    const first = eventsFor(bet, wallet, entry, ctx).map((e) => e.eventId);
    const second = eventsFor(bet, wallet, entry, { correlationId: 'outro' }).map((e) => e.eventId);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
    expect(first[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicEventId('a')).not.toBe(deterministicEventId('b'));
  });

  test('rejeição gera só WagerTransactionRejected; pendência só WagerTransactionPendingReference', () => {
    const wallet = Wallet.open({ playerId: 'player-1', initialBalance: brl('1') }).wallet;
    const bet = WagerTransaction.create(txProps({ walletId: wallet.id, money: brl('25') }));
    applyWager(wallet, bet, { reference: null, referenceAlreadyReversed: false });
    expect(eventsFor(bet, wallet, null, ctx).map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
    expect(eventsFor(bet, wallet, null, ctx)[0]!.toJSON().data).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS' });

    const refund = WagerTransaction.create(
      txProps({ walletId: wallet.id, kind: 'REFUND', externalTransactionId: 'r', referenceExternalTransactionId: 'x' }),
    );
    applyWager(wallet, refund, { reference: null, referenceAlreadyReversed: false });
    expect(eventsFor(refund, wallet, null, ctx).map((e) => e.eventType)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('OutboxMessage', () => {
  const message = () => {
    const { wallet, bet, entry } = processedBet();
    return OutboxMessage.enqueue(eventsFor(bet, wallet, entry, ctx)[0]!);
  };

  test('nasce pendente e vencida, com o envelope como payload', () => {
    const m = message();
    expect(m.isPending()).toBe(true);
    expect(m.isDue(new Date(Date.now() + 1))).toBe(true);
    expect(m.attempts).toBe(0);
    expect(m.payload).toMatchObject({ eventId: m.id, eventType: 'WagerTransactionProcessed' });
  });

  test('scheduleRetry aplica backoff exponencial limitado a 300 s', () => {
    const m = message();
    const now = new Date('2026-01-01T00:00:00Z');
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      m.scheduleRetry(now);
      delays.push((m.nextAttemptAt!.getTime() - now.getTime()) / 1000);
    }
    expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
    expect(m.attempts).toBe(10);
    expect(m.isDue(now)).toBe(false);
  });

  test('markPublished encerra a mensagem', () => {
    const m = message();
    const at = new Date();
    m.markPublished(at);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date(at.getTime() + 1_000_000))).toBe(false);
    expect(m.publishedAt).toBe(at);
  });
});
