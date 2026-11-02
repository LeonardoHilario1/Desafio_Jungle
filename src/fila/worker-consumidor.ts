import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../configuracao';
import { WagerTransactionConsumer } from './consumidor-transacoes';

const ERROR_PAUSE_MS = 1000;

/**
 * loop do consumidor dentro do processo. cada instância roda o seu; o SQS entrega cada
 * mensagem pra um consumidor por vez (visibilidade), e o FIFO segura a ordem por grupo.
 *
 * shutdown (SIGTERM chega aqui pelo enableShutdownHooks do Nest):
 * 1. paro de buscar e aborto o long polling em andamento;
 * 2. a mensagem que já está sendo processada termina (com ack depois do commit);
 * 3. as que vieram no lote e ainda não começaram eu devolvo com visibilidade 0, pra
 *    outra instância pegar na hora.
 * se o processo morrer sem passar por aqui, nada se perde: o que não teve ack volta
 * quando a visibilidade vencer, e a inbox evita repetir o que já foi commitado.
 */
@Injectable()
export class ConsumerWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ConsumerWorker.name);
  private running = false;
  private abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(WagerTransactionConsumer) private readonly consumer: WagerTransactionConsumer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.consumer.enabled) return;
    this.running = true;
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    this.logger.log('encerrando o consumidor: parando de buscar mensagens');
    this.running = false;
    this.abort.abort();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.config.consumer.shutdownTimeoutMs));
    await Promise.race([this.loop, timeout]);
    this.logger.log('consumidor encerrado');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages;
      try {
        messages = await this.consumer.receive(this.abort.signal);
      } catch (error) {
        if (!this.running) break;
        this.logger.error(`falha ao receber da fila: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, ERROR_PAUSE_MS));
        continue;
      }
      for (const message of messages) {
        try {
          if (this.running) await this.consumer.handle(message);
          else await this.consumer.release(message);
        } catch (error) {
          // falha no próprio SQS (ack, DLQ): a mensagem volta sozinha quando a visibilidade vencer
          this.logger.error(`falha ao tratar mensagem ${message.MessageId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}
