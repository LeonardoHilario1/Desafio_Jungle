import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261031000000_base } from './Migration20261031000000_base';
import { Migration20261102000000_carteiras_e_transacoes } from './Migration20261102000000_carteiras_e_transacoes';
import { Migration20261102010000_ledger } from './Migration20261102010000_ledger';
import { Migration20261102020000_outbox } from './Migration20261102020000_outbox';
import { Migration20261102030000_inbox_e_pendencias } from './Migration20261102030000_inbox_e_pendencias';

// preferi listar na mão em vez de descobrir por glob: funciona igual no Bun, no container
// e nos testes, e a ordem fica visível no código
export const migrations: MigrationObject[] = [
  { name: 'Migration20261031000000_base', class: Migration20261031000000_base },
  { name: 'Migration20261102000000_carteiras_e_transacoes', class: Migration20261102000000_carteiras_e_transacoes },
  { name: 'Migration20261102010000_ledger', class: Migration20261102010000_ledger },
  { name: 'Migration20261102020000_outbox', class: Migration20261102020000_outbox },
  { name: 'Migration20261102030000_inbox_e_pendencias', class: Migration20261102030000_inbox_e_pendencias },
];
