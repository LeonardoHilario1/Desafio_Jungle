import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261031000000_baseline } from './Migration20261031000000_baseline';
import { Migration20261102000000_wallets_and_transactions } from './Migration20261102000000_wallets_and_transactions';
import { Migration20261102010000_ledger } from './Migration20261102010000_ledger';
import { Migration20261102020000_outbox } from './Migration20261102020000_outbox';

// Lista explícita em vez de descoberta por glob: funciona igual no Bun, no container
// e nos testes, e a ordem de execução fica visível no código.
export const migrations: MigrationObject[] = [
  { name: 'Migration20261031000000_baseline', class: Migration20261031000000_baseline },
  { name: 'Migration20261102000000_wallets_and_transactions', class: Migration20261102000000_wallets_and_transactions },
  { name: 'Migration20261102010000_ledger', class: Migration20261102010000_ledger },
  { name: 'Migration20261102020000_outbox', class: Migration20261102020000_outbox },
];
