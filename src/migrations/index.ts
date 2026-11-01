import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261031000000_baseline } from './Migration20261031000000_baseline';
import { Migration20261101000000_wagering_schema } from './Migration20261101000000_wagering_schema';
import { Migration20261101010000_opening_balance } from './Migration20261101010000_opening_balance';

// Lista explícita em vez de descoberta por glob: funciona igual no Bun, no container
// e nos testes, e a ordem de execução fica visível no código.
export const migrations: MigrationObject[] = [
  { name: 'Migration20261031000000_baseline', class: Migration20261031000000_baseline },
  { name: 'Migration20261101000000_wagering_schema', class: Migration20261101000000_wagering_schema },
  { name: 'Migration20261101010000_opening_balance', class: Migration20261101010000_opening_balance },
];
