import type { LoggerService } from '@nestjs/common';
import { currentTrace } from './contexto';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * logger do Nest que escreve uma linha JSON por evento, com os campos de rastreio do
 * contexto atual (correlationId, messageId, transactionId, walletId, providerId).
 *
 * de propósito, nada de payload nem valores de dinheiro: os logs dizem o que aconteceu e
 * com qual transação; o detalhe financeiro fica no banco, que é auditável.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    if (RANK[level] > RANK[this.level]) return;
    // o Nest manda o nome do contexto (classe) como último parâmetro string
    const context = typeof params[params.length - 1] === 'string' ? (params.pop() as string) : undefined;
    // campos extras: logger.log({ msg, ...campos }, 'Contexto')
    const fields = typeof message === 'object' && message !== null && !(message instanceof Error) ? message : { msg: message };
    const stack = params.find((p): p is string => typeof p === 'string' && p.includes('\n    at '));
    this.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        ...(context !== undefined && { context }),
        ...currentTrace(),
        ...(message instanceof Error ? { msg: message.message, stack: message.stack } : fields),
        ...(stack !== undefined && { stack }),
      }),
    );
  }
}
