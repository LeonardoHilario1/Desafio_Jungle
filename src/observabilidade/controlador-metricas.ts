import { Controller, Get, Header, Inject } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Metrics } from './metricas';

/**
 * GET /metrics no formato do Prometheus. aberto como o health: em produção ficaria numa
 * porta interna. os gauges que dependem do banco (atraso da outbox, pendências) eu calculo
 * na hora do scrape, numa query só; se o banco estiver fora, saem as métricas em memória.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(MikroORM) private readonly orm: MikroORM,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    try {
      const [row] = await this.orm.em.getConnection().execute<
        { pending: number; lag_seconds: string | null; pending_references: number }[]
      >(`
        select (select count(*)::int from outbox_messages where published_at is null) as pending,
               (select extract(epoch from now() - min(occurred_at))::text
                  from outbox_messages where published_at is null) as lag_seconds,
               (select count(*)::int from wager_transactions where status = 'PENDING_REFERENCE') as pending_references
      `);
      this.metrics.set('wagering_outbox_pending_messages', row!.pending);
      this.metrics.set('wagering_outbox_lag_seconds', row!.lag_seconds === null ? 0 : Number(row!.lag_seconds));
      this.metrics.set('wagering_pending_references', row!.pending_references);
    } catch {
      // sem banco, os gauges ficam com o último valor; o /health/ready é quem avisa
    }
    return this.metrics.render();
  }
}
