import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { ProcessWagerTransaction } from '../../src/aplicacao/processar-transacao-aposta';
import { RecordPermanentFailure } from '../../src/aplicacao/registrar-falha';
import { WagerTransactionConsumer, type ConsumeOutcome } from '../../src/fila/consumidor-transacoes';
import type { TestApi } from './api';
import { testConfig } from './test-config';

const config = testConfig();

export const sqs = new SQSClient({
  region: config.sqs.region,
  endpoint: config.sqs.endpoint,
  credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
});

export interface TestQueues {
  inputQueueName: string;
  dlqName: string;
  inputUrl: string;
  dlqUrl: string;
  remove(): Promise<void>;
}

/** fila FIFO de entrada + DLQ só pro teste, pra não misturar mensagens entre testes */
export async function createQueues(visibilityTimeoutSeconds = 30): Promise<TestQueues> {
  const id = crypto.randomUUID().slice(0, 18);
  const inputQueueName = `wt-${id}.fifo`;
  const dlqName = `wt-${id}-dlq.fifo`;
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: fifo }))).QueueUrl!;
  const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] })))
    .Attributes!.QueueArn!;
  const inputUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: inputQueueName,
        Attributes: {
          ...fifo,
          VisibilityTimeout: String(visibilityTimeoutSeconds),
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '10' }),
        },
      }),
    )
  ).QueueUrl!;
  return {
    inputQueueName,
    dlqName,
    inputUrl,
    dlqUrl,
    remove: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: inputUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

/** consumidor montado com os casos de uso de uma instância de teste */
export function consumerFor(
  api: TestApi,
  queues: TestQueues,
  options: { client?: SQSClient; maxAttempts?: number; outcomes?: ConsumeOutcome[] } = {},
): WagerTransactionConsumer {
  return new WagerTransactionConsumer(
    api.app.get(ProcessWagerTransaction),
    api.app.get(RecordPermanentFailure),
    options.client ?? sqs,
    { inputQueueName: queues.inputQueueName, dlqName: queues.dlqName },
    { name: 'wager-transactions-consumer', maxAttempts: options.maxAttempts ?? 3, retryBaseSeconds: 0, waitTimeSeconds: 1 },
    options.outcomes ? { onOutcome: (o) => options.outcomes!.push(o) } : {},
  );
}

/** envelope do desafio; dedupId diferente simula o produtor publicando a mesma mensagem duas vezes */
export async function sendMessage(
  queues: TestQueues,
  data: Record<string, unknown>,
  options: { messageId?: string; dedupId?: string; rawBody?: string } = {},
): Promise<string> {
  const messageId = options.messageId ?? `msg-${crypto.randomUUID()}`;
  const body =
    options.rawBody ??
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { idempotencyKey: `${data.providerId}:${data.externalTransactionId}`, ...data },
    });
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.inputUrl,
      MessageBody: body,
      MessageGroupId: String(data.walletId ?? 'grupo'),
      MessageDeduplicationId: options.dedupId ?? crypto.randomUUID(),
    }),
  );
  return messageId;
}

/** lê tudo que tiver numa fila (sem apagar), esperando até ter `expected` mensagens */
export async function peekAll(url: string, expected: number, timeoutMs = 8000): Promise<Message[]> {
  const seen = new Map<string, Message>();
  const deadline = Date.now() + timeoutMs;
  while (seen.size < expected && Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    for (const m of res.Messages ?? []) seen.set(m.MessageId!, m);
  }
  return [...seen.values()];
}

/** consome até a fila ficar vazia por duas voltas seguidas (ou acabarem as voltas) */
export async function drain(consumer: WagerTransactionConsumer, maxRounds = 40): Promise<ConsumeOutcome[]> {
  const all: ConsumeOutcome[] = [];
  let empty = 0;
  for (let round = 0; round < maxRounds && empty < 2; round++) {
    const outcomes = await consumer.pollOnce();
    empty = outcomes.length === 0 ? empty + 1 : 0;
    all.push(...outcomes);
  }
  return all;
}
