/**
 * quanto esperar entre as tentativas de achar a referência de uma PENDING_REFERENCE e
 * quando desistir. o padrão (1 s dobrando até 60 s, 10 tentativas) dá uns 5 minutos no
 * total: a referência normalmente chega em segundos, e 5 minutos já cobrem reentrega da
 * fila e retry do provedor. depois disso é REFERENCE_NOT_FOUND e vira assunto operacional.
 */
export interface ReferenceRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_REFERENCE_RETRY: ReferenceRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 10,
};

/** próxima checagem depois de `attempts` tentativas sem sucesso */
export function nextReferenceCheck(now: Date, attempts: number, policy: ReferenceRetryPolicy): Date {
  const delay = Math.min(policy.baseDelayMs * 2 ** attempts, policy.maxDelayMs);
  return new Date(now.getTime() + delay);
}
