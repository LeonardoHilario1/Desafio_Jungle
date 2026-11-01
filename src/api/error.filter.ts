import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ApplicationError, type ApplicationErrorCode } from '../application/application-error';
import { DomainError, type DomainErrorCode } from '../domain/domain-error';
import { ApiError } from './api-error';

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
  setHeader(name: string, value: string): unknown;
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

const APPLICATION_STATUS: Record<ApplicationErrorCode, number> = {
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_CONFLICT: 409,
  WALLET_BUSY: 503,
};

// Sugestão de espera para falhas transitórias (WALLET_BUSY).
const RETRY_AFTER_SECONDS = '1';

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
    const send = (status: number, code: string, message: string, details?: Record<string, string>) =>
      response.status(status).json({ error: { code, message, ...(details && { details }) } });

    if (exception instanceof ApiError) {
      send(exception.status, exception.code, exception.message, exception.details);
      return;
    }

    if (exception instanceof ApplicationError) {
      if (exception.transient) response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
      send(APPLICATION_STATUS[exception.code], exception.code, exception.message, exception.details);
      return;
    }

    if (exception instanceof DomainError && DOMAIN_STATUS[exception.code] !== undefined) {
      send(DOMAIN_STATUS[exception.code] ?? 400, exception.code, exception.message);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 400) {
        send(400, 'INVALID_REQUEST', exception.message);
      } else {
        response.status(status).json(exception.getResponse());
      }
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    send(500, 'INTERNAL_ERROR', 'Erro interno');
  }
}
