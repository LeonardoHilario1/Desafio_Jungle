import { describe, expect, test } from 'bun:test';
import { addTrace, runWithTrace } from '../../src/observabilidade/contexto';
import { JsonLogger } from '../../src/observabilidade/logger-json';
import { Metrics } from '../../src/observabilidade/metricas';

function capture(level: ConstructorParameters<typeof JsonLogger>[0] = 'info') {
  const lines: Record<string, unknown>[] = [];
  return { logger: new JsonLogger(level, (line) => lines.push(JSON.parse(line))), lines };
}

describe('JsonLogger', () => {
  test('uma linha JSON por evento, com os campos de rastreio do contexto', async () => {
    const { logger, lines } = capture();
    await runWithTrace({ correlationId: 'corr-1', messageId: 'msg-1' }, async () => {
      await Promise.resolve();
      addTrace({ transactionId: 'tx-1', walletId: 'w-1', providerId: 'provider-a' });
      logger.log({ msg: 'transação tratada', status: 'PROCESSED' }, 'ProcessWagerTransaction');
    });
    expect(lines).toEqual([
      {
        time: expect.any(String),
        level: 'info',
        context: 'ProcessWagerTransaction',
        correlationId: 'corr-1',
        messageId: 'msg-1',
        transactionId: 'tx-1',
        walletId: 'w-1',
        providerId: 'provider-a',
        msg: 'transação tratada',
        status: 'PROCESSED',
      },
    ]);
  });

  test('respeita o nível e aceita mensagem em texto ou Error', () => {
    const { logger, lines } = capture('warn');
    logger.log('ignorado');
    logger.warn('aviso', 'Ctx');
    logger.error(new Error('falhou'));
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ['warn', 'aviso'],
      ['error', 'falhou'],
    ]);
    expect(lines[1]!.stack).toEqual(expect.stringContaining('falhou'));
  });

  test('fora de um contexto, não inventa campos de rastreio', () => {
    const { logger, lines } = capture();
    logger.log('solto');
    expect(Object.keys(lines[0]!).sort()).toEqual(['level', 'msg', 'time']);
  });
});

describe('Metrics', () => {
  test('renderiza contadores, gauges e histogramas no formato do Prometheus', () => {
    const metrics = new Metrics();
    metrics.inc('wagering_transactions_total', { source: 'http', kind: 'BET', status: 'PROCESSED' });
    metrics.inc('wagering_transactions_total', { source: 'http', kind: 'BET', status: 'PROCESSED' });
    metrics.set('wagering_outbox_lag_seconds', 1.5);
    metrics.observe('wagering_processing_duration_seconds', 0.02, { source: 'http' });

    const text = metrics.render();
    expect(text).toContain('# TYPE wagering_transactions_total counter');
    expect(text).toContain('wagering_transactions_total{kind="BET",source="http",status="PROCESSED"} 2');
    expect(text).toContain('wagering_outbox_lag_seconds 1.5');
    expect(text).toContain('wagering_processing_duration_seconds_bucket{source="http",le="0.01"} 0');
    expect(text).toContain('wagering_processing_duration_seconds_bucket{source="http",le="0.025"} 1');
    expect(text).toContain('wagering_processing_duration_seconds_count{source="http"} 1');
  });

  test('métrica não declarada é erro de programação', () => {
    expect(() => new Metrics().inc('nao_existe')).toThrow('não declarada');
  });
});
