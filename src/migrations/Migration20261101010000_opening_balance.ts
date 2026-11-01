import { Migration } from '@mikro-orm/migrations';

/**
 * Saldo inicial da carteira como lançamento de abertura (OPENING) no ledger.
 * O lançamento de abertura não tem transação de aposta, é sempre CREDIT e existe no
 * máximo um por carteira. Com isso, saldo = soma do ledger vale desde a criação.
 *
 * ADD COLUMN e ALTER COLUMN não disparam os triggers de linha que bloqueiam UPDATE.
 */
export class Migration20261101010000_opening_balance extends Migration {
  override up(): void {
    this.addSql(`alter table wallet_ledger_entries add column kind varchar(16) not null default 'TRANSACTION';`);
    this.addSql(`alter table wallet_ledger_entries alter column transaction_id drop not null;`);
    this.addSql(`
      alter table wallet_ledger_entries
        add constraint wallet_ledger_entries_kind_ck check (
             (kind = 'TRANSACTION' and transaction_id is not null)
          or (kind = 'OPENING' and transaction_id is null and direction = 'CREDIT')
        );
    `);
    this.addSql(`create unique index wallet_ledger_entries_one_opening_uq
                   on wallet_ledger_entries (wallet_id) where kind = 'OPENING';`);
  }

  override down(): void {
    this.addSql(`
      do $$
      begin
        if exists (select 1 from wallet_ledger_entries where kind = 'OPENING') then
          raise exception 'down recusado: existem lançamentos de abertura no ledger';
        end if;
      end
      $$;
    `);
    this.addSql(`drop index wallet_ledger_entries_one_opening_uq;`);
    this.addSql(`alter table wallet_ledger_entries drop constraint wallet_ledger_entries_kind_ck;`);
    this.addSql(`alter table wallet_ledger_entries alter column transaction_id set not null;`);
    this.addSql(`alter table wallet_ledger_entries drop column kind;`);
  }
}
