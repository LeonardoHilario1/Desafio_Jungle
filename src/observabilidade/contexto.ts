import { AsyncLocalStorage } from 'node:async_hooks';

/** campos de rastreio que vão automaticamente em todo log da requisição ou mensagem */
export interface TraceFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<TraceFields>();

/** roda fn com esses campos de rastreio; logs dentro dela (mesmo assíncronos) levam os campos */
export function runWithTrace<T>(fields: TraceFields, fn: () => T): T {
  return storage.run({ ...fields }, fn);
}

/** completa o contexto atual (ex.: quando descubro o transactionId no meio do caminho) */
export function addTrace(fields: TraceFields): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export function currentTrace(): TraceFields {
  return storage.getStore() ?? {};
}
