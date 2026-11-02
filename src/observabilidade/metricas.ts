type Labels = Record<string, string>;

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]!.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
}

interface Family {
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: Map<string, number>;
  histograms: Map<string, { buckets: number[]; sum: number; count: number }>;
}

/**
 * métricas no formato texto do Prometheus, sem dependência externa. ficam em memória, uma
 * série por instância (o Prometheus soma as instâncias na consulta). gauges que dependem
 * do banco (atraso da outbox, pendências) são calculados na hora do scrape.
 */
export class Metrics {
  private readonly families = new Map<string, Family>();

  constructor() {
    this.define('wagering_transactions_total', 'counter', 'transações tratadas, por origem, kind e status final');
    this.define('wagering_idempotent_replays_total', 'counter', 'duplicatas detectadas pela Idempotency-Key (replay)');
    this.define('wagering_inbox_duplicates_total', 'counter', 'mensagens da fila reentregues e barradas pela inbox');
    this.define('wagering_lock_timeouts_total', 'counter', 'conflitos de lock: desistências esperando o lock da carteira');
    this.define('wagering_processing_duration_seconds', 'histogram', 'latência do processamento de uma transação');
    this.define('wagering_consumer_messages_total', 'counter', 'mensagens da fila por resultado');
    this.define('wagering_consumer_retries_total', 'counter', 'mensagens devolvidas pra fila com backoff (falha transitória)');
    this.define('wagering_dlq_messages_total', 'counter', 'mensagens mandadas pra DLQ, por motivo');
    this.define('wagering_pending_reference_checks_total', 'counter', 'checagens do worker de pendências, por resultado');
    this.define('wagering_outbox_published_total', 'counter', 'mensagens da outbox publicadas no SQS');
    this.define('wagering_outbox_publish_failures_total', 'counter', 'falhas ao publicar mensagens da outbox');
    this.define('wagering_reconciliations_total', 'counter', 'reconciliações, por resultado');
    this.define('wagering_outbox_pending_messages', 'gauge', 'mensagens da outbox ainda não publicadas');
    this.define('wagering_outbox_lag_seconds', 'gauge', 'idade da mensagem pendente mais antiga da outbox');
    this.define('wagering_pending_references', 'gauge', 'transações em PENDING_REFERENCE');
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const family = this.family(name);
    const k = key(labels);
    family.values.set(k, (family.values.get(k) ?? 0) + by);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    this.family(name).values.set(key(labels), value);
  }

  observe(name: string, seconds: number, labels: Labels = {}): void {
    const family = this.family(name);
    const k = key(labels);
    let h = family.histograms.get(k);
    if (!h) {
      h = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
      family.histograms.set(k, h);
    }
    DURATION_BUCKETS.forEach((le, i) => {
      if (seconds <= le) h!.buckets[i]! += 1;
    });
    h.sum += seconds;
    h.count += 1;
  }

  /** valor atual de uma série (pros testes) */
  value(name: string, labels: Labels = {}): number {
    return this.family(name).values.get(key(labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, f] of this.families) {
      lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`);
      for (const [k, v] of f.values) lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
      for (const [k, h] of f.histograms) {
        const sep = k ? `${k},` : '';
        DURATION_BUCKETS.forEach((le, i) => lines.push(`${name}_bucket{${sep}le="${le}"} ${h.buckets[i]}`));
        lines.push(`${name}_bucket{${sep}le="+Inf"} ${h.count}`);
        lines.push(`${name}_sum${k ? `{${k}}` : ''} ${h.sum}`, `${name}_count${k ? `{${k}}` : ''} ${h.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private define(name: string, type: Family['type'], help: string): void {
    this.families.set(name, { help, type, values: new Map(), histograms: new Map() });
  }

  private family(name: string): Family {
    const f = this.families.get(name);
    if (!f) throw new Error(`Métrica não declarada: ${name}`);
    return f;
  }
}
