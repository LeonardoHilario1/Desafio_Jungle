import { DriverException, UniqueConstraintViolationException } from '@mikro-orm/core';

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    (error as UniqueConstraintViolationException & { constraint?: string }).constraint === constraint
  );
}

/** 55P03 lock_not_available: estourou o lock_timeout esperando o lock da carteira. */
export function isLockTimeout(error: unknown): boolean {
  return error instanceof DriverException && error.code === '55P03';
}
