import { createHash } from 'node:crypto';

type CanonicalValue = string | null | CanonicalValue[] | { [key: string]: CanonicalValue };

/** JSON com chaves de objeto ordenadas e sem espaços, para que o hash não dependa da ordem. */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`).join(',')}}`;
}

export function sha256Hex(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
