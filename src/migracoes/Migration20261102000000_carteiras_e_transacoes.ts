import { Migration } from '@mikro-orm/migrations';

/**
 * Carteiras e transações. As garantias que não podem depender só do código ficam aqui:
 * - unicidade: carteira por (player_id, currency); Idempotency-Key; transação por
 *   (provider_id, external_transaction_id); uma OPENING por carteira; uma reversão
 *   processada por referência;
 * - não negatividade: CHECK (balance >= 0), valores >= 0 e forma de cada kind;
 * - referência: FK composta garante que a transação referenciada é do mesmo provedor,
 *   jogador, carteira, moeda e rodada;
 * - imutabilidade: campos de negócio nunca mudam, estados terminais são definitivos e
 *   nada é excluído (trigger).
 */
export class Migration20261102000000_carteiras_e_transacoes extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id          uuid           primary key,
        player_id   varchar(255)   not null,
        currency    char(3)        not null,
        balance     numeric(18,2)  not null,
        version     integer        not null,
        created_at  timestamptz    not null default now(),
        updated_at  timestamptz    not null default now(),
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- Alvo da FK composta do ledger (wallet_id, currency).
        constraint wallets_id_currency_uq unique (id, currency),
        constraint wallets_player_id_not_blank_ck check (btrim(player_id) <> ''),
        constraint wallets_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_ck check (balance >= 0),
        constraint wallets_version_positive_ck check (version >= 1)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id                                 uuid           primary key,
        provider_id                        varchar(255)   not null,
        external_transaction_id            varchar(255)   not null,
        idempotency_key                    varchar(255)   not null,
        payload_hash                       char(64)       not null,
        wallet_id                          uuid           not null,
        player_id                          varchar(255)   not null,
        round_id                           varchar(255),
        game_id                            varchar(255),
        kind                               varchar(16)    not null,
        currency                           char(3)        not null,
        amount                             numeric(18,2)  not null,
        reference_external_transaction_id  varchar(255),
        reference_transaction_id           uuid,
        correlation_id                     varchar(255)   not null,
        status                             varchar(32)    not null,
        failure_code                       varchar(64),
        observed_balance                   numeric(18,2),
        -- Moeda do saldo observado: a da carteira, que difere da transação em CURRENCY_MISMATCH.
        observed_currency                  char(3),
        created_at                         timestamptz    not null default now(),
        processed_at                       timestamptz,

        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        constraint wager_transactions_provider_external_uq unique (provider_id, external_transaction_id),
        -- Alvos de FKs compostas: ledger (id, wallet_id, currency) e referência.
        constraint wager_transactions_id_wallet_currency_uq unique (id, wallet_id, currency),
        constraint wager_transactions_reference_target_uq
          unique (id, provider_id, player_id, wallet_id, currency, round_id),
        -- A moeda pode divergir da carteira: a transação é gravada REJECTED com
        -- CURRENCY_MISMATCH, para ficar auditável. O ledger é que exige a moeda da carteira.
        constraint wager_transactions_wallet_fk foreign key (wallet_id) references wallets (id),
        constraint wager_transactions_reference_fk
          foreign key (reference_transaction_id, provider_id, player_id, wallet_id, currency, round_id)
          references wager_transactions (id, provider_id, player_id, wallet_id, currency, round_id),

        constraint wager_transactions_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_kind_ck
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_ck
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_non_negative_ck check (amount >= 0),
        constraint wager_transactions_observed_balance_non_negative_ck check (observed_balance >= 0),
        constraint wager_transactions_shape_ck check (
             (kind = 'OPENING'  and reference_external_transaction_id is null and amount > 0 and status = 'PROCESSED')
          or (kind = 'BET'      and reference_external_transaction_id is null and amount > 0)
          or (kind = 'WIN'      and amount > 0)
          or (kind = 'LOSS'     and amount >= 0)
          or (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null and amount > 0)
        ),
        -- O provedor 'internal' é reservado à OPENING, que não tem rodada nem jogo.
        constraint wager_transactions_internal_ck check ((provider_id = 'internal') = (kind = 'OPENING')),
        constraint wager_transactions_round_game_ck
          check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        constraint wager_transactions_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_ck
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint wager_transactions_observed_balance_ck
          check (status in ('PENDING', 'FAILED') or observed_balance is not null),
        constraint wager_transactions_observed_currency_ck
          check ((observed_balance is null) = (observed_currency is null)),
        constraint wager_transactions_pending_reference_ck
          check (status <> 'PENDING_REFERENCE' or reference_external_transaction_id is not null),
        -- Processada com referência informada ⇔ vinculada a ela; só processadas têm vínculo.
        constraint wager_transactions_reference_linked_ck check (
          case when status = 'PROCESSED'
               then (reference_external_transaction_id is null) = (reference_transaction_id is null)
               else reference_transaction_id is null
          end
        )
      );
    `);

    this.addSql(`create index wager_transactions_wallet_idx on wager_transactions (wallet_id, created_at);`);
    // Uma transação OPENING por carteira.
    this.addSql(`create unique index wager_transactions_one_opening_uq
                   on wager_transactions (wallet_id) where kind = 'OPENING';`);
    // Uma referência é revertida (REFUND ou ROLLBACK) no máximo uma vez.
    this.addSql(`create unique index wager_transactions_one_reversal_uq
                   on wager_transactions (reference_transaction_id)
                   where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');`);
    // Dependentes aguardando uma referência, para reprocessamento.
    this.addSql(`create index wager_transactions_pending_reference_idx
                   on wager_transactions (provider_id, reference_external_transaction_id)
                   where status = 'PENDING_REFERENCE';`);

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
        if old.status = 'PENDING_REFERENCE' and new.status = 'PENDING' then
          raise exception 'transação % não volta de PENDING_REFERENCE para PENDING', old.id
            using errcode = 'P0001', hint = 'TRANSACTION_IMMUTABLE';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.currency, new.amount,
            new.reference_external_transaction_id, new.correlation_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.currency, old.amount,
            old.reference_external_transaction_id, old.correlation_id, old.created_at) then
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
    // Reverter apaga dados financeiros: só com as tabelas vazias.
    this.addSql(`
      do $$
      begin
        if exists (select 1 from wager_transactions) or exists (select 1 from wallets) then
          raise exception 'down recusado: existem carteiras ou transações';
        end if;
      end
      $$;
    `);
    this.addSql(`drop table wager_transactions;`);
    this.addSql(`drop function wager_transactions_guard();`);
    this.addSql(`drop table wallets;`);
  }
}
