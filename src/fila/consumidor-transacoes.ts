import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApiError } from '../api/erro-api';
import { optionalString, parseBody, requiredMoney, requiredString, requireUuid } from '../api/requisicao';
import { ApplicationError } from '../aplicacao/erro-aplicacao';
import type { ProcessWagerTransaction, WagerTransactionCommand } from '../aplicacao/processar-transacao-aposta';
import type { RecordPermanentFailure } from '../aplicacao/registrar-falha';
import type { ConsumerConfig, SqsConfig } from '../configuracao';
import { DomainError } from '../dominio/erro-dominio';
import { sha256Hex } from '../dominio/hash-payload';
import type { SubmittableKind } from '../dominio/transacao-aposta';
import { addTrace, runWithTrace } from '../observabilidade/contexto';

export const MESSAGE_TYPE = 'WagerTransactionRequested';
const MAX_BACKOFF_SECONDS = 300;
const MAX_ATTRIBUTE_LENGTH = 256;

/** o que aconteceu com uma mensagem */
export type ConsumeOutcome =
  /** processada (PROCESSED, REJECTED ou PENDING_REFERENCE) e apagada da fila */
  | 'ACKED'
  /** já estava na inbox: reentrega, apagada sem repetir o efeito */
  | 'DUPLICATE'
  /** falha transitória: volta pra fila depois do backoff */
  | 'RETRY'
  /** falha permanente ou tentativas esgotadas: foi pra DLQ */
  | 'DEAD_LETTERED'
  /** devolvida sem processar (shutdown) */
  | 'RELEASED';

/** quem observa o consumidor (métricas, logs); tudo opcional */
export interface ConsumerObserver {
  onOutcome?(outcome: ConsumeOutcome, info: { messageId?: string; errorCode?: string }): void;
}

interface ParsedMessage {
  messageId: string;
  command: WagerTransactionCommand;
}

/**
 * consumidor da fila wager-transactions.fifo. usa o mesmo caso de uso da API
 * (ProcessWagerTransaction), passando a inbox junto pra que a dedupe por
 * (consumidor, messageId) entre no mesmo commit do efeito.
 *
 * o ack (DeleteMessage) só acontece depois do commit. se o processo morrer entre um e
 * outro, a mensagem volta quando a visibilidade vencer, cai na inbox e é só apagada.
 *
 * como cada erro é tratado:
 * - negócio (REJECTED, PENDING_REFERENCE) não é erro: ack;
 * - permanente (mensagem malformada, carteira inexistente, conflito de idempotência,
 *   mesmo messageId com outro conteúdo): vai direto pra DLQ, repetir não adianta;
 * - transitório (carteira ocupada, banco fora, qualquer erro inesperado): devolvo a
 *   mensagem com backoff mudando a visibilidade; depois de maxAttempts recebimentos,
 *   gravo a transação como FAILED (melhor esforço) e mando pra DLQ.
 *
 * a DLQ recebe a mensagem original com errorCode, errorMessage e receiveCount nos
 * atributos. a fila também tem RedrivePolicy como rede de segurança, caso o processo
 * morra justo na hora de mover.
 */
export class WagerTransactionConsumer {
  private readonly urls = new Map<string, string>();

  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly recordFailure: RecordPermanentFailure,
    private readonly sqs: SQSClient,
    private readonly sqsConfig: Pick<SqsConfig, 'inputQueueName' | 'dlqName'>,
    private readonly config: Pick<ConsumerConfig, 'name' | 'maxAttempts' | 'retryBaseSeconds' | 'waitTimeSeconds'>,
    private readonly observer: ConsumerObserver = {},
  ) {}

  async receive(signal?: AbortSignal): Promise<Message[]> {
    const result = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.url(this.sqsConfig.inputQueueName),
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.config.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
      signal ? { abortSignal: signal } : {},
    );
    return result.Messages ?? [];
  }

  /** recebe um lote e processa em ordem (a ordem do FIFO dentro de cada grupo é mantida) */
  async pollOnce(): Promise<ConsumeOutcome[]> {
    const outcomes: ConsumeOutcome[] = [];
    for (const message of await this.receive()) outcomes.push(await this.handle(message));
    return outcomes;
  }

  /** cada mensagem roda no seu próprio contexto de rastreio, que vai pros logs */
  handle(message: Message): Promise<ConsumeOutcome> {
    return runWithTrace({ ...(message.MessageId !== undefined && { messageId: message.MessageId }) }, () =>
      this.handleTraced(message),
    );
  }

  private async handleTraced(message: Message): Promise<ConsumeOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    let parsed: ParsedMessage;
    try {
      parsed = parseMessage(message.Body);
    } catch (error) {
      return this.deadLetter(message, 'INVALID_MESSAGE', error, receiveCount);
    }

    const { messageId, command } = parsed;
    const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? messageId;
    addTrace({ messageId, correlationId });
    try {
      const result = await this.processWager.execute(
        command,
        { correlationId, causationId: messageId },
        {
          consumerName: this.config.name,
          messageId,
          payloadHash: sha256Hex(command as unknown as Record<string, string>),
          receivedAt: new Date(),
        },
      );
      await this.ack(message);
      return this.report(result.duplicateMessage ? 'DUPLICATE' : 'ACKED', { messageId });
    } catch (error) {
      if (isPermanent(error)) return this.deadLetter(message, errorCode(error), error, receiveCount, messageId);
      if (receiveCount >= this.config.maxAttempts) {
        await this.recordFailure.execute(command, correlationId);
        return this.deadLetter(message, `RETRIES_EXHAUSTED:${errorCode(error)}`, error, receiveCount, messageId);
      }
      await this.delay(message, Math.min(this.config.retryBaseSeconds * 2 ** (receiveCount - 1), MAX_BACKOFF_SECONDS));
      return this.report('RETRY', { messageId, errorCode: errorCode(error) });
    }
  }

  /** devolve a mensagem pra fila na hora, sem processar (usado no shutdown) */
  async release(message: Message): Promise<ConsumeOutcome> {
    await this.delay(message, 0);
    return this.report('RELEASED', {});
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: await this.url(this.sqsConfig.inputQueueName), ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async delay(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(this.sqsConfig.inputQueueName),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /** manda pra DLQ e só depois apaga da fila; se o envio falhar, a mensagem fica e volta depois */
  private async deadLetter(
    message: Message,
    code: string,
    error: unknown,
    receiveCount: number,
    messageId?: string,
  ): Promise<ConsumeOutcome> {
    const attribute = (value: string) => ({ DataType: 'String', StringValue: value.slice(0, MAX_ATTRIBUTE_LENGTH) });
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.url(this.sqsConfig.dlqName),
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          errorCode: attribute(code),
          errorMessage: attribute(error instanceof Error ? error.message : String(error)),
          receiveCount: attribute(String(receiveCount)),
          consumer: attribute(this.config.name),
        },
      }),
    );
    await this.ack(message);
    return this.report('DEAD_LETTERED', { ...(messageId !== undefined && { messageId }), errorCode: code });
  }

  private report(outcome: ConsumeOutcome, info: { messageId?: string; errorCode?: string }): ConsumeOutcome {
    this.observer.onOutcome?.(outcome, info);
    return outcome;
  }

  private async url(queueName: string): Promise<string> {
    let url = this.urls.get(queueName);
    if (url === undefined) {
      const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (!result.QueueUrl) throw new Error(`Fila ${queueName} sem URL`);
      url = result.QueueUrl;
      this.urls.set(queueName, url);
    }
    return url;
  }
}

/** valida o envelope { messageId, type, occurredAt, data } e monta o comando */
export function parseMessage(body: string | undefined): ParsedMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '');
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', 'Mensagem não é JSON');
  }
  const envelope = parseBody(raw, ['messageId', 'type', 'occurredAt', 'data']);
  if (requiredString(envelope, 'type') !== MESSAGE_TYPE) {
    throw new ApiError(400, 'INVALID_REQUEST', `type deve ser ${MESSAGE_TYPE}`);
  }
  const messageId = requiredString(envelope, 'messageId');
  if (messageId.trim() === '' || messageId.length > 255) {
    throw new ApiError(400, 'INVALID_REQUEST', 'messageId deve ter de 1 a 255 caracteres');
  }
  requiredString(envelope, 'occurredAt');
  const data = parseBody(envelope.data, [
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
    'kind',
    'money',
    'referenceExternalTransactionId',
  ]);
  return {
    messageId,
    command: {
      idempotencyKey: requiredString(data, 'idempotencyKey'),
      providerId: requiredString(data, 'providerId'),
      externalTransactionId: requiredString(data, 'externalTransactionId'),
      playerId: requiredString(data, 'playerId'),
      walletId: requireUuid(requiredString(data, 'walletId'), 'walletId'),
      roundId: requiredString(data, 'roundId'),
      gameId: requiredString(data, 'gameId'),
      kind: requiredString(data, 'kind') as SubmittableKind,
      money: requiredMoney(data, 'money'),
      referenceExternalTransactionId: optionalString(data, 'referenceExternalTransactionId'),
    },
  };
}

function isPermanent(error: unknown): boolean {
  if (error instanceof ApiError || error instanceof DomainError) return true;
  return error instanceof ApplicationError && !error.transient;
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError || error instanceof DomainError || error instanceof ApplicationError) return error.code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}
