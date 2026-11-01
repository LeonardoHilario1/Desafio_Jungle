import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxMessage } from '../domain/outbox-message';
import { OutboxMessageRecord } from '../persistence/entity-schemas';
import { outboxFromRecord, writeOutboxMessage } from '../persistence/mappers';

// Limite do SendMessageBatch do SQS.
export const OUTBOX_BATCH_SIZE = 10;
const MAX_ERROR_LENGTH = 1000;

export interface PublishResult {
  published: number;
  failed: number;
}

/**
 * Publica mensagens da outbox no SQS.
 *
 * - Só lê linhas commitadas, então nada é publicado antes do commit da transação
 *   financeira.
 * - FOR UPDATE SKIP LOCKED (LockMode.PESSIMISTIC_PARTIAL_WRITE): vários publishers, em
 *   qualquer instância, publicam em paralelo sem pegar a mesma linha e sem esperar.
 * - At-least-once: se o processo cair depois do envio e antes do commit que marca
 *   published_at, a mensagem é reenviada por quem pegar a linha depois. O consumidor
 *   deduplica pelo eventId (atributo da mensagem e campo do envelope), que é
 *   determinístico por fato.
 * - Falha de envio agenda nova tentativa com backoff (OutboxMessage.scheduleRetry).
 */
export class OutboxPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  /** Publica um lote de mensagens vencidas. */
  async publishBatch(now: Date = new Date()): Promise<PublishResult> {
    return this.orm.em.fork().transactional(async (em) => {
      const records = await em.find(
        OutboxMessageRecord,
        { publishedAt: null, nextAttemptAt: { $lte: now } },
        { orderBy: { nextAttemptAt: 'asc' }, limit: OUTBOX_BATCH_SIZE, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );
      if (records.length === 0) return { published: 0, failed: 0 };

      const messages = records.map(outboxFromRecord);
      const failures = await this.send(messages);
      messages.forEach((message, i) => {
        const record = records[i]!;
        const error = failures.get(message.id);
        if (error === undefined) {
          message.markPublished(now);
        } else {
          message.scheduleRetry(now);
          record.lastError = error.slice(0, MAX_ERROR_LENGTH);
        }
        writeOutboxMessage(message, record);
      });
      return { published: messages.length - failures.size, failed: failures.size };
    });
  }

  /** Envia o lote e devolve as falhas por id da mensagem. */
  private async send(messages: OutboxMessage[]): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    try {
      const result = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: await this.resolveQueueUrl(),
          Entries: messages.map((m) => ({
            Id: m.id,
            MessageBody: JSON.stringify(m.payload),
            MessageAttributes: {
              eventId: { DataType: 'String', StringValue: m.id },
              eventType: { DataType: 'String', StringValue: m.eventType },
            },
          })),
        }),
      );
      for (const failed of result.Failed ?? []) {
        if (failed.Id) failures.set(failed.Id, `${failed.Code}: ${failed.Message ?? ''}`);
      }
      // Entrada sem confirmação nem falha explícita é tratada como falha.
      const succeeded = new Set((result.Successful ?? []).map((s) => s.Id));
      for (const m of messages) {
        if (!succeeded.has(m.id) && !failures.has(m.id)) failures.set(m.id, 'sem confirmação do SQS');
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      for (const m of messages) failures.set(m.id, message);
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
