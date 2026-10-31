import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config';
import { HealthController } from './health/health.controller';
import { ReadinessService } from './health/readiness.service';
import { ormOptions } from './mikro-orm.config';

// Módulo dinâmico: a configuração entra por parâmetro, e os testes montam a
// aplicação apontando para o banco de testes sem mexer em process.env.
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormOptions(config.db))],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: SQSClient,
          useFactory: () =>
            new SQSClient({
              region: config.sqs.region,
              endpoint: config.sqs.endpoint,
              credentials: {
                accessKeyId: config.sqs.accessKeyId,
                secretAccessKey: config.sqs.secretAccessKey,
              },
            }),
        },
        ReadinessService,
      ],
    };
  }
}
