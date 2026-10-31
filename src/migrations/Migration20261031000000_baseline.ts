import { Migration } from '@mikro-orm/migrations';

/**
 * Migration de base: fixa o fuso do banco em UTC, para que timestamps exibidos e
 * funções como now()::date não dependam do fuso do servidor. As tabelas do domínio
 * chegam na Etapa 3.
 *
 * ALTER DATABASE precisa do nome literal; current_database() deixa a migration
 * funcionar igual no banco da aplicação e no de testes.
 */
export class Migration20261031000000_baseline extends Migration {
  override up(): void {
    this.addSql(`
      do $$
      begin
        execute format('alter database %I set timezone to %L', current_database(), 'UTC');
      end
      $$;
    `);
  }

  override down(): void {
    this.addSql(`
      do $$
      begin
        execute format('alter database %I reset timezone', current_database());
      end
      $$;
    `);
  }
}
