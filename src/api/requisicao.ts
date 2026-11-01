import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../dominio/dinheiro';
import type { EventContext } from '../dominio/eventos/evento-integracao';
import { ApiError } from './erro-api';

// Validação manual da forma do corpo. As regras de valor (formato do amount, moeda,
// tamanho dos campos) ficam no domínio; aqui só se garante tipo e campos conhecidos.
// Campos desconhecidos são rejeitados para que um erro de digitação não passe calado.

type Body = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[\w.:-]{1,128}$/;

function invalid(message: string): ApiError {
  return new ApiError(400, 'INVALID_REQUEST', message);
}

export function parseBody(body: unknown, allowed: readonly string[]): Body {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('O corpo deve ser um objeto JSON');
  }
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw invalid(`Campos desconhecidos: ${unknown.join(', ')}`);
  }
  return body as Body;
}

export function requiredString(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw invalid(`${field} é obrigatório e deve ser string`);
  }
  return value;
}

export function optionalString(body: Body, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalid(`${field} deve ser string`);
  }
  return value;
}

/** { amount, currency }, ambos string. amount numérico é rejeitado: dinheiro não passa por number. */
export function requiredMoney(body: Body, field: string): MoneyProps {
  const value = body[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${field} é obrigatório e deve ser { amount, currency }`);
  }
  const money = parseBody(value, ['amount', 'currency']);
  const part = (name: 'amount' | 'currency'): string => {
    if (typeof money[name] !== 'string') throw invalid(`${field}.${name} é obrigatório e deve ser string`);
    return money[name];
  };
  return { amount: part('amount'), currency: part('currency') };
}

export function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw invalid(`${field} deve ser um UUID`);
  }
  return value.toLowerCase();
}

/** X-Correlation-Id recebido (se bem formado) ou um novo; propagado para logs e eventos. */
export function eventContext(correlationHeader: string | undefined, causationId?: string): EventContext {
  const correlationId =
    correlationHeader !== undefined && CORRELATION_ID_PATTERN.test(correlationHeader) ? correlationHeader : randomUUID();
  return { correlationId, ...(causationId !== undefined && { causationId }) };
}
