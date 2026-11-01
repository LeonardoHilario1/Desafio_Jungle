import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

// Limite do SendMessageBatch do SQS.
export const OUTBOX_BATCH_SIZE = 10;
const MAX_BACKOFF_SECONDS = 300;
const MAX_ERROR_LENGTH = 1000;

interface PendingRow {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
}

/**
 * Publica eventos do outbox no SQS.
 *
 * - Só lê linhas commitadas, então nada é publicado antes do commit da transação
 *   financeira.
 * - FOR UPDATE SKIP LOCKED: várias instâncias publicam em paralelo sem pegar a mesma
 *   linha e sem esperar umas pelas outras.
 * - At-least-once: se o processo cair depois do envio e antes do commit que marca
 *   published_at, o evento é reenviado. O consumidor deduplica pelo eventId (atributo
 *   da mensagem e campo do payload).
 * - Falha de envio incrementa attempts e agenda nova tentativa com backoff exponencial.
 */
export class OutboxPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  /** Publica um lote de eventos pendentes. Devolve quantos foram publicados. */
  async publishBatch(): Promise<number> {
    return this.orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<PendingRow[]>(
        `select id, event_type, payload
           from outbox_events
          where published_at is null and next_attempt_at <= now()
          order by created_at
          limit ?
          for update skip locked`,
        [OUTBOX_BATCH_SIZE],
      );
      if (rows.length === 0) return 0;

      const failures = await this.send(rows);
      for (const row of rows) {
        const error = failures.get(row.id);
        if (error === undefined) {
          await em.execute('update outbox_events set published_at = now() where id = ?', [row.id]);
        } else {
          await em.execute(
            `update outbox_events
                set attempts = attempts + 1,
                    last_error = ?,
                    next_attempt_at = now() + least(power(2, attempts + 1), ?) * interval '1 second'
              where id = ?`,
            [error.slice(0, MAX_ERROR_LENGTH), MAX_BACKOFF_SECONDS, row.id],
          );
        }
      }
      return rows.length - failures.size;
    });
  }

  /** Envia o lote e devolve as falhas por id do evento. */
  private async send(rows: PendingRow[]): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    try {
      const result = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: await this.resolveQueueUrl(),
          Entries: rows.map((row) => ({
            Id: row.id,
            MessageBody: JSON.stringify(row.payload),
            MessageAttributes: {
              eventId: { DataType: 'String', StringValue: row.id },
              eventType: { DataType: 'String', StringValue: row.event_type },
            },
          })),
        }),
      );
      for (const failed of result.Failed ?? []) {
        if (failed.Id) failures.set(failed.Id, `${failed.Code}: ${failed.Message ?? ''}`);
      }
      // Entrada sem confirmação nem falha explícita é tratada como falha.
      const succeeded = new Set((result.Successful ?? []).map((s) => s.Id));
      for (const row of rows) {
        if (!succeeded.has(row.id) && !failures.has(row.id)) failures.set(row.id, 'sem confirmação do SQS');
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      for (const row of rows) failures.set(row.id, message);
    }
    return failures;
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl === undefined) {
      const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
      if (!result.QueueUrl) throw new Error(`Fila ${this.queueName} sem URL`);
      this.queueUrl = result.QueueUrl;
    }
    return this.queueUrl;
  }
}
