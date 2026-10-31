import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261031000000_baseline } from './Migration20261031000000_baseline';

// Lista explícita em vez de descoberta por glob: funciona igual no Bun, no container
// e nos testes, e a ordem de execução fica visível no código.
export const migrations: MigrationObject[] = [
  { name: 'Migration20261031000000_baseline', class: Migration20261031000000_baseline },
];
