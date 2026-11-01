import { Migration } from '@mikro-orm/migrations';

/**
 * outbox transacional. a linha nasce no mesmo commit da mudança financeira; o publisher
 * manda pro SQS e marca published_at. vários publishers disputam as linhas com
 * FOR UPDATE SKIP LOCKED.
 *
 * o id é o eventId, determinístico por (transação, tipo de evento): a PK não deixa gravar
 * o mesmo fato duas vezes. o payload é o envelope do IntegrationEvent.
 *
 * imutabilidade: id, tipo, agregado, payload e occurred_at nunca mudam; published_at,
 * depois de preenchido, não volta; nenhuma linha é apagada.
 */
export class Migration20261102020000_outbox extends Migration {
  override up(): void {
    this.addSql(`
      create table outbox_messages (
        id               uuid         primary key,
        aggregate_id     uuid         not null,
        event_type       varchar(64)  not null,
        payload          jsonb        not null,
        occurred_at      timestamptz  not null,
        created_at       timestamptz  not null default now(),
        attempts         integer      not null default 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       text,
        constraint outbox_messages_attempts_ck check (attempts >= 0),
        constraint outbox_messages_schedule_ck check ((published_at is null) = (next_attempt_at is not null)),
        constraint outbox_messages_envelope_ck check (
          payload ->> 'eventId' = id::text and payload ->> 'eventType' = event_type
        )
      );
    `);
    this.addSql(`create index outbox_messages_pending_idx on outbox_messages (next_attempt_at)
                   where published_at is null;`);

    this.addSql(`
      create function outbox_messages_guard() returns trigger
      language plpgsql as $$
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception 'outbox_messages não permite %', tg_op
            using errcode = 'P0001', hint = 'OUTBOX_IMMUTABLE';
        end if;
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at, new.created_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at, old.created_at)
           or (old.published_at is not null and new.published_at is distinct from old.published_at) then
          raise exception 'mensagem % da outbox: só o controle de publicação pode mudar', old.id
            using errcode = 'P0001', hint = 'OUTBOX_IMMUTABLE';
        end if;
        return new;
      end
      $$;
    `);
    this.addSql(`
      create trigger outbox_messages_guard_update_delete
        before update or delete on outbox_messages
        for each row execute function outbox_messages_guard();
    `);
    this.addSql(`
      create trigger outbox_messages_guard_truncate
        before truncate on outbox_messages
        for each statement execute function outbox_messages_guard();
    `);
  }

  override down(): void {
    this.addSql(`
      do $$
      begin
        if exists (select 1 from outbox_messages) then
          raise exception 'down recusado: outbox_messages contém mensagens';
        end if;
      end
      $$;
    `);
    this.addSql(`drop table outbox_messages;`);
    this.addSql(`drop function outbox_messages_guard();`);
  }
}
