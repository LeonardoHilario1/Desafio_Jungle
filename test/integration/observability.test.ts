import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Metrics } from '../../src/observabilidade/metricas';
import { startApi, type TestApi } from '../support/api';
import { resetDatabase } from '../support/database';
import { createWallet, submit, txBody } from '../support/wagering';

let api: TestApi;

beforeAll(async () => {
  api = await startApi();
});

beforeEach(async () => {
  await resetDatabase(api.orm);
});

afterAll(async () => {
  await api.close();
});

async function metricsText(): Promise<string> {
  const url = (await api.app.getUrl()).replace('[::1]', '127.0.0.1');
  const res = await fetch(`${url}/metrics`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
}

describe('correlationId', () => {
  test('o X-Correlation-Id recebido volta na resposta; sem ele, um novo é gerado', async () => {
    const w = await createWallet(api, '100');
    const body = txBody(w, 'BET', '1');
    const withHeader = await api.post('/wagering/transactions', body, {
      'idempotency-key': `provider-a:${body.externalTransactionId}`,
      'x-correlation-id': 'corr-xyz',
    });
    expect(withHeader.headers.get('x-correlation-id')).toBe('corr-xyz');

    const without = await api.get(`/wallets/${w.id}`);
    expect(without.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('o correlationId gerado pelo middleware é o mesmo gravado na transação', async () => {
    const w = await createWallet(api, '100');
    const res = await submit(api, txBody(w, 'BET', '1'));
    const detail = await api.get(`/wagering/transactions/${res.body.transactionId}`);
    expect(detail.body.correlationId).toBe(res.headers.get('x-correlation-id'));
  });
});

describe('GET /metrics', () => {
  test('conta transações por status, duplicatas, latência, conflitos e atraso da outbox', async () => {
    const metrics = api.app.get(Metrics);
    const before = metrics.value('wagering_transactions_total', { source: 'http', kind: 'BET', status: 'PROCESSED' });

    const w = await createWallet(api, '10');
    const body = txBody(w, 'BET', '5');
    await submit(api, body);
    await submit(api, body); // duplicata
    await submit(api, txBody(w, 'BET', '50')); // rejeitada

    const text = await metricsText();
    expect(metrics.value('wagering_transactions_total', { source: 'http', kind: 'BET', status: 'PROCESSED' })).toBe(before + 1);
    expect(text).toMatch(/wagering_transactions_total\{kind="BET",source="http",status="REJECTED"\} \d+/);
    expect(text).toMatch(/wagering_idempotent_replays_total\{source="http"\} \d+/);
    expect(text).toMatch(/wagering_processing_duration_seconds_count\{source="http"\} \d+/);
    // a outbox não é publicada nos testes (publisher desligado): tem pendência e atraso
    expect(text).toMatch(/wagering_outbox_pending_messages [1-9]\d*/);
    expect(text).toMatch(/wagering_outbox_lag_seconds \d+(\.\d+)?/);
    expect(text).toContain('# TYPE wagering_lock_timeouts_total counter');
    expect(text).toContain('# TYPE wagering_dlq_messages_total counter');
  });

  test('reconciliação divergente é contada', async () => {
    const metrics = api.app.get(Metrics);
    const before = metrics.value('wagering_reconciliations_total', { result: 'divergent' });
    const w = await createWallet(api, '100');
    await api.orm.em.getConnection().execute('update wallets set balance = 1 where id = ?', [w.id]);
    await api.post(`/wallets/${w.id}/reconciliation`, {});
    expect(metrics.value('wagering_reconciliations_total', { result: 'divergent' })).toBe(before + 1);
  });
});
