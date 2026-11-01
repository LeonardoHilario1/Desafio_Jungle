import { Migration } from '@mikro-orm/migrations';

/**
 * Ledger append-only. Cada lançamento:
 * - pertence a uma transação PROCESSED que move saldo (trigger de inserção) e é o único
 *   dela (UNIQUE transaction_id);
 * - tem a moeda da carteira e da transação (FKs compostas);
 * - fecha a conta: balance_before ± amount = balance_after, sem saldo negativo (CHECK);
 * - é o único da sua versão da carteira (UNIQUE wallet_id, wallet_version), que também
 *   serve de índice para a paginação do ledger.
 * UPDATE, DELETE e TRUNCATE são bloqueados por trigger.
 */
export class Migration20261102010000_ledger extends Migration {
  override up(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid           primary key,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        direction       varchar(6)     not null,
        currency        char(3)        not null,
        amount          numeric(18,2)  not null,
        balance_before  numeric(18,2)  not null,
        balance_after   numeric(18,2)  not null,
        wallet_version  integer        not null,
        created_at      timestamptz    not null default now(),
        -- Uma transação gera no máximo um lançamento: replay nunca debita duas vezes.
        constraint wallet_ledger_entries_transaction_uq unique (transaction_id),
        -- Um lançamento por versão da carteira: duas escritas que partissem do mesmo saldo
        -- (lost update) colidiriam aqui. Também dá a ordem total do ledger da carteira.
        constraint wallet_ledger_entries_wallet_version_uq unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id, wallet_id, currency) references wager_transactions (id, wallet_id, currency),
        constraint wallet_ledger_entries_wallet_version_ck check (wallet_version >= 1),
        constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive_ck check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative_ck check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_balanced_ck check (
          balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end
        )
      );
    `);

    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries é append-only: % não é permitido', tg_op
          using errcode = 'P0001', hint = 'LEDGER_IMMUTABLE';
      end
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_append_only();
    `);

    // Lançamento só para transação PROCESSED que move saldo (LOSS e REJECTED não geram).
    this.addSql(`
      create function wallet_ledger_entries_require_processed() returns trigger
      language plpgsql as $$
      begin
        if not exists (select 1 from wager_transactions t
                        where t.id = new.transaction_id and t.status = 'PROCESSED' and t.kind <> 'LOSS') then
          raise exception 'lançamento % exige transação PROCESSED que move saldo', new.id
            using errcode = 'P0001', hint = 'LEDGER_REQUIRES_PROCESSED_TRANSACTION';
        end if;
        return new;
      end
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_require_processed
        before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_require_processed();
    `);
  }

  override down(): void {
    this.addSql(`
      do $$
      begin
        if exists (select 1 from wallet_ledger_entries) then
          raise exception 'down recusado: wallet_ledger_entries contém lançamentos';
        end if;
      end
      $$;
    `);
    this.addSql(`drop table wallet_ledger_entries;`);
    this.addSql(`drop function wallet_ledger_entries_append_only();`);
    this.addSql(`drop function wallet_ledger_entries_require_processed();`);
  }
}
