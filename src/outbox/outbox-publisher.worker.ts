import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { OUTBOX_BATCH_SIZE, OutboxPublisher } from './outbox-publisher';

/**
 * Loop de publicação dentro do processo da aplicação. Cada instância roda o seu; o
 * SKIP LOCKED do publisher divide o trabalho entre elas. Lote cheio publica o próximo
 * em seguida; lote parcial ou vazio espera pollIntervalMs.
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outbox.publisherEnabled) return;
    this.running = true;
    this.loop = this.run();
  }

  // Antes do shutdown dos módulos, para o ORM não fechar com um lote em andamento.
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        const result = await this.publisher.publishBatch();
        claimed = result.published + result.failed;
      } catch (error) {
        this.logger.error(`Falha ao publicar outbox: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (claimed < OUTBOX_BATCH_SIZE) {
        await new Promise((resolve) => setTimeout(resolve, this.config.outbox.pollIntervalMs));
      }
    }
  }
}
