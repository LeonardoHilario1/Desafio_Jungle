import { Migration } from '@mikro-orm/migrations';

/**
 * migration de base: deixo o fuso do banco em UTC, pra timestamp exibido e coisas como
 * now()::date não dependerem do fuso do servidor.
 *
 * ALTER DATABASE precisa do nome literal; com current_database() a mesma migration
 * funciona no banco da aplicação e no de testes.
 */
export class Migration20261031000000_base extends Migration {
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
