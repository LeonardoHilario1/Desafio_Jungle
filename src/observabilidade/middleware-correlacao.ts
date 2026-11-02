import { randomUUID } from 'node:crypto';
import { validCorrelationId } from '../api/requisicao';
import { runWithTrace } from './contexto';

interface Request {
  headers: Record<string, string | string[] | undefined>;
}
interface Response {
  setHeader(name: string, value: string): unknown;
}

/**
 * toda requisição HTTP ganha um correlationId: o X-Correlation-Id que veio (se estiver bem
 * formado) ou um novo. ele volta no header da resposta, vai pros logs (contexto) e pra
 * transação e os eventos gravados.
 */
export function correlationMiddleware(req: Request, res: Response, next: () => void): void {
  const header = req.headers['x-correlation-id'];
  const correlationId = validCorrelationId(typeof header === 'string' ? header : undefined) ?? randomUUID();
  res.setHeader('X-Correlation-Id', correlationId);
  runWithTrace({ correlationId }, next);
}
