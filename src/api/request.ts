import { ApiError } from './api-error';

// Validação manual da forma do corpo. As regras de valor (formato do amount, moeda,
// tamanho das chaves) ficam no domínio; aqui só se garante tipo e campos conhecidos.
// Campos desconhecidos são rejeitados para que um erro de digitação não passe calado.

type Body = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw invalid(`${field} deve ser um UUID`);
  }
  return value.toLowerCase();
}
