import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../configuracao';

const CHECK_TIMEOUT_MS = 2000;

export type CheckResult = { status: 'up' } | { status: 'down'; reason: string };

export interface ReadinessReport {
  ready: boolean;
  checks: { database: CheckResult; queue: CheckResult };
}

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, queue] = await Promise.all([this.checkDatabase(), this.checkQueue()]);
    return { ready: database.status === 'up' && queue.status === 'up', checks: { database, queue } };
  }

  private async checkDatabase(): Promise<CheckResult> {
    try {
      await withTimeout(this.orm.em.getConnection().execute('select 1'), CHECK_TIMEOUT_MS);
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', reason: describe(error) };
    }
  }

  private async checkQueue(): Promise<CheckResult> {
    try {
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.outboxQueueName }), {
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', reason: describe(error) };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout após ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
