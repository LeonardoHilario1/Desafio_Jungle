import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ReadinessService, type ReadinessReport } from './verificacao-prontidao';

@Controller('health')
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  // liveness não olha dependência: se o banco cair, reiniciar o processo não resolve nada
  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (!report.ready) {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
