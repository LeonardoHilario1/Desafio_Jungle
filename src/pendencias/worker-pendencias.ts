import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { RetryPendingReferences } from '../aplicacao/reprocessar-pendencias';
import { APP_CONFIG, type AppConfig } from '../configuracao';

/**
 * loop que chama o RetryPendingReferences de tempos em tempos. pode rodar em todas as
 * instâncias: cada pendência é tratada sob o lock da carteira e relida antes, então duas
 * instâncias nunca aplicam a mesma pendência.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(RetryPendingReferences) private readonly retry: RetryPendingReferences,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.pendingReference.workerEnabled) return;
    this.running = true;
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.retry.runOnce();
      } catch (error) {
        this.logger.error(`falha ao reprocessar pendências: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.pendingReference.pollIntervalMs));
    }
  }
}
