import { Migration } from '@mikro-orm/migrations';

/**
 * Schema do domínio. As regras que não podem depender só do código ficam aqui:
 * - unicidade: carteira por (player_id, currency), idempotency_key, um lançamento por
 *   transação e uma liquidação processada por BET;
 * - não negatividade: CHECK (balance >= 0) e valores >= 0 / > 0;
 * - consistência entre tabelas: FKs compostas garantem que transação e lançamento
 *   têm a mesma moeda da carteira, que o lançamento é da mesma carteira da transação e
 *   que a BET liquidada é da mesma carteira da WIN/LOSS;
 * - imutabilidade: o ledger é append-only, e transações têm os campos de negócio
 *   imutáveis e não saem de estado terminal.
 */
export class Migration20261101000000_wagering_schema extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id          uuid           primary key,
        player_id   varchar(255)   not null,
        currency    char(3)        not null,
        balance     numeric(18,2)  not null default 0,
        version     integer        not null default 1,
        created_at  timestamptz    not null default now(),
        updated_at  timestamptz    not null default now(),
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- Alvo das FKs compostas (wallet_id, currency).
        constraint wallets_id_currency_uq unique (id, currency),
        constraint wallets_player_id_not_blank_ck check (btrim(player_id) <> ''),
        constraint wallets_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_ck check (balance >= 0),
        constraint wallets_version_positive_ck check (version >= 1)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id                        uuid           primary key,
        idempotency_key           varchar(255)   not null,
        payload_hash              char(64)       not null,
        wallet_id                 uuid           not null,
        type                      varchar(16)    not null,
        currency                  char(3)        not null,
        amount                    numeric(18,2)  not null,
        reference_key             varchar(255),
        reference_transaction_id  uuid,
        status                    varchar(32)    not null,
        failure_code              varchar(64),
        created_at                timestamptz    not null default now(),
        processed_at              timestamptz,
        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        -- Alvo da FK composta do ledger (transaction_id, wallet_id).
        constraint wager_transactions_id_wallet_uq unique (id, wallet_id),
        constraint wager_transactions_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        -- A BET liquidada é da mesma carteira.
        constraint wager_transactions_reference_fk
          foreign key (reference_transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint wager_transactions_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_type_ck check (type in ('BET', 'WIN', 'LOSS')),
        constraint wager_transactions_status_ck
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_shape_ck check (
             (type = 'BET'  and reference_key is null     and amount > 0)
          or (type = 'WIN'  and reference_key is not null and amount > 0)
          or (type = 'LOSS' and reference_key is not null and amount = 0)
        ),
        constraint wager_transactions_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_ck
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint wager_transactions_pending_reference_ck
          check (status <> 'PENDING_REFERENCE' or type <> 'BET'),
        constraint wager_transactions_settlement_linked_ck
          check (status <> 'PROCESSED' or type = 'BET' or reference_transaction_id is not null)
      );
    `);

    this.addSql(`create index wager_transactions_wallet_idx on wager_transactions (wallet_id, created_at);`);
    this.addSql(`create index wager_transactions_reference_key_idx on wager_transactions (reference_key)
                   where reference_key is not null;`);
    // Uma BET só é liquidada (WIN ou LOSS) uma vez.
    this.addSql(`create unique index wager_transactions_one_settlement_per_bet_uq
                   on wager_transactions (reference_transaction_id)
                   where status = 'PROCESSED' and type in ('WIN', 'LOSS');`);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid           primary key,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        direction       varchar(6)     not null,
        currency        char(3)        not null,
        amount          numeric(18,2)  not null,
        balance_after   numeric(18,2)  not null,
        created_at      timestamptz    not null default now(),
        -- Uma transação gera no máximo um lançamento: replay nunca debita duas vezes.
        constraint wallet_ledger_entries_transaction_uq unique (transaction_id),
        constraint wallet_ledger_entries_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_wallet_fk
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive_ck check (amount > 0),
        constraint wallet_ledger_entries_balance_after_non_negative_ck check (balance_after >= 0)
      );
    `);
    this.addSql(`create index wallet_ledger_entries_wallet_idx on wallet_ledger_entries (wallet_id, created_at);`);

    // Ledger append-only: nenhuma alteração ou exclusão, nem por TRUNCATE.
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

    // Transações: campos de negócio imutáveis, estado terminal definitivo, sem exclusão.
    this.addSql(`
      create function wager_transactions_guard() returns trigger
      language plpgsql as $$
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception 'wager_transactions não permite %', tg_op
            using errcode = 'P0001', hint = 'TRANSACTION_IMMUTABLE';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transação % já está em estado terminal (%)', old.id, old.status
            using errcode = 'P0001', hint = 'TRANSACTION_IMMUTABLE';
        end if;
        if (new.id, new.idempotency_key, new.payload_hash, new.wallet_id, new.type,
            new.currency, new.amount, new.reference_key, new.created_at)
           is distinct from
           (old.id, old.idempotency_key, old.payload_hash, old.wallet_id, old.type,
            old.currency, old.amount, old.reference_key, old.created_at) then
          raise exception 'campos de negócio da transação % são imutáveis', old.id
            using errcode = 'P0001', hint = 'TRANSACTION_IMMUTABLE';
        end if;
        return new;
      end
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard_update_delete
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);
    this.addSql(`
      create trigger wager_transactions_guard_truncate
        before truncate on wager_transactions
        for each statement execute function wager_transactions_guard();
    `);
  }

  override down(): void {
    // Reverter apaga dados financeiros. Só é permitido com o ledger vazio, para que
    // um down acidental em um ambiente com dados falhe em vez de destruir o ledger.
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
    this.addSql(`drop table wager_transactions;`);
    this.addSql(`drop function wager_transactions_guard();`);
    this.addSql(`drop table wallets;`);
  }
}
