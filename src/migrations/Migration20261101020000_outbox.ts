import { Migration } from '@mikro-orm/migrations';

/**
 * Outbox transacional. A linha nasce no mesmo commit da transação financeira; o
 * publisher a envia ao SQS e marca published_at. Vários publishers disputam linhas com
 * FOR UPDATE SKIP LOCKED.
 *
 * Imutabilidade: id, tipo, agregado, payload e created_at nunca mudam; published_at,
 * uma vez preenchido, não volta; linhas não são excluídas.
 */
export class Migration20261101020000_outbox extends Migration {
  override up(): void {
    this.addSql(`
      create table outbox_events (
        id               uuid         primary key,
        event_type       varchar(64)  not null,
        aggregate_id     uuid         not null,
        payload          jsonb        not null,
        created_at       timestamptz  not null default now(),
        published_at     timestamptz,
        attempts         integer      not null default 0,
        next_attempt_at  timestamptz  not null default now(),
        last_error       text,
        constraint outbox_events_aggregate_fk foreign key (aggregate_id) references wager_transactions (id),
        -- Um evento de cada tipo por transação: um replay nunca gera evento duplicado.
        constraint outbox_events_aggregate_type_uq unique (aggregate_id, event_type),
        constraint outbox_events_attempts_ck check (attempts >= 0)
      );
    `);
    this.addSql(`create index outbox_events_pending_idx on outbox_events (next_attempt_at, created_at)
                   where published_at is null;`);

    this.addSql(`
      create function outbox_events_guard() returns trigger
      language plpgsql as $$
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception 'outbox_events não permite %', tg_op
            using errcode = 'P0001', hint = 'OUTBOX_IMMUTABLE';
        end if;
        if (new.id, new.event_type, new.aggregate_id, new.payload, new.created_at)
           is distinct from (old.id, old.event_type, old.aggregate_id, old.payload, old.created_at)
           or (old.published_at is not null and new.published_at is distinct from old.published_at) then
          raise exception 'evento % do outbox: só o controle de publicação pode mudar', old.id
            using errcode = 'P0001', hint = 'OUTBOX_IMMUTABLE';
        end if;
        return new;
      end
      $$;
    `);
    this.addSql(`
      create trigger outbox_events_guard_update_delete
        before update or delete on outbox_events
        for each row execute function outbox_events_guard();
    `);
    this.addSql(`
      create trigger outbox_events_guard_truncate
        before truncate on outbox_events
        for each statement execute function outbox_events_guard();
    `);
  }

  override down(): void {
    this.addSql(`
      do $$
      begin
        if exists (select 1 from outbox_events) then
          raise exception 'down recusado: outbox_events contém eventos';
        end if;
      end
      $$;
    `);
    this.addSql(`drop table outbox_events;`);
    this.addSql(`drop function outbox_events_guard();`);
  }
}
