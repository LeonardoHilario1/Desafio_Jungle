import { Migration } from '@mikro-orm/migrations';

/**
 * inbox do consumidor SQS e controle de reprocessamento das PENDING_REFERENCE.
 *
 * inbox_messages: uma linha por (consumidor, messageId), gravada na mesma transação SQL da
 * mudança financeira. se a linha existe, a mensagem já foi processada e commitada; uma
 * reentrega (crash antes do ack, visibilidade vencida) cai na PK e não repete o efeito.
 *
 * wager_transactions ganha reference_attempts e next_reference_check_at, que o worker usa
 * pra saber quando tentar de novo e quando desistir (REFERENCE_NOT_FOUND).
 */
export class Migration20261102030000_inbox_e_pendencias extends Migration {
  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name   varchar(64)   not null,
        message_id      varchar(255)  not null,
        payload_hash    char(64)      not null,
        transaction_id  uuid          not null,
        received_at     timestamptz   not null,
        processed_at    timestamptz   not null,
        constraint inbox_messages_pk primary key (consumer_name, message_id),
        constraint inbox_messages_transaction_fk foreign key (transaction_id) references wager_transactions (id),
        constraint inbox_messages_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint inbox_messages_processed_after_received_ck check (processed_at >= received_at)
      );
    `);
    // inbox é registro de auditoria: não muda nem some
    this.addSql(`
      create function inbox_messages_append_only() returns trigger
      language plpgsql as $$
      begin
        raise exception 'inbox_messages é append-only: % não é permitido', tg_op
          using errcode = 'P0001', hint = 'INBOX_IMMUTABLE';
      end
      $$;
    `);
    this.addSql(`
      create trigger inbox_messages_no_update_delete
        before update or delete on inbox_messages
        for each row execute function inbox_messages_append_only();
    `);
    this.addSql(`
      create trigger inbox_messages_no_truncate
        before truncate on inbox_messages
        for each statement execute function inbox_messages_append_only();
    `);

    this.addSql(`alter table wager_transactions
                   add column reference_attempts integer not null default 0,
                   add column next_reference_check_at timestamptz;`);
    // pendências que já existiam entram na fila do worker agora
    this.addSql(`update wager_transactions set next_reference_check_at = now() where status = 'PENDING_REFERENCE';`);
    this.addSql(`alter table wager_transactions
                   add constraint wager_transactions_reference_attempts_ck check (reference_attempts >= 0),
                   add constraint wager_transactions_reference_check_ck
                     check ((status = 'PENDING_REFERENCE') = (next_reference_check_at is not null));`);
    this.addSql(`create index wager_transactions_reference_check_idx
                   on wager_transactions (next_reference_check_at) where status = 'PENDING_REFERENCE';`);
  }

  override down(): void {
    this.addSql(`
      do $$
      begin
        if exists (select 1 from inbox_messages) then
          raise exception 'down recusado: inbox_messages contém mensagens';
        end if;
      end
      $$;
    `);
    this.addSql(`drop table inbox_messages;`);
    this.addSql(`drop function inbox_messages_append_only();`);
    this.addSql(`drop index wager_transactions_reference_check_idx;`);
    this.addSql(`alter table wager_transactions
                   drop constraint wager_transactions_reference_check_ck,
                   drop constraint wager_transactions_reference_attempts_ck,
                   drop column next_reference_check_at,
                   drop column reference_attempts;`);
  }
}
