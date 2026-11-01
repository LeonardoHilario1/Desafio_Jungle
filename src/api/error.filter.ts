import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { DomainError, type DomainErrorCode } from '../domain/domain-error';
import { ApiError } from './api-error';

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

// Erros de domínio que chegam aqui são entrada inválida. Regras de negócio
// (saldo insuficiente etc.) não viram exceção: a transação é gravada como REJECTED.
const DOMAIN_STATUS: Partial<Record<DomainErrorCode, number>> = {
  INVALID_AMOUNT: 400,
  INVALID_CURRENCY: 400,
  AMOUNT_OUT_OF_RANGE: 400,
  INVALID_TRANSACTION: 400,
  INVALID_WALLET: 400,
};

/**
 * Formato único de erro: { error: { code, message, details? } }.
 * HttpException do Nest (por exemplo JSON malformado, ou o 503 do /health/ready)
 * mantém o status e o corpo originais.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();

    if (exception instanceof ApiError) {
      response.status(exception.status).json({
        error: { code: exception.code, message: exception.message, ...(exception.details && { details: exception.details }) },
      });
      return;
    }

    if (exception instanceof DomainError && DOMAIN_STATUS[exception.code] !== undefined) {
      response.status(DOMAIN_STATUS[exception.code] ?? 400).json({
        error: { code: exception.code, message: exception.message },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 400) {
        response.status(400).json({ error: { code: 'INVALID_REQUEST', message: exception.message } });
      } else {
        response.status(status).json(exception.getResponse());
      }
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno' } });
  }
}
