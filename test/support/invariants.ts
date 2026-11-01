import type { MikroORM } from '@mikro-orm/postgresql';

export interface InvariantViolation {
  walletId: string;
  rule: string;
  detail: string;
}

/**
 * Confere, direto no banco, as invariantes financeiras de todas as carteiras:
 * - saldo da carteira = saldo reconstruído pelo ledger (créditos - débitos);
 * - os lançamentos de cada carteira encadeiam (por wallet_version): o balance_before de
 *   cada um é o balance_after do anterior, começando em zero;
 * - version = 1 + lançamentos fora da abertura (version só muda quando o saldo muda);
 * - transação PROCESSED que move saldo tem exatamente um lançamento, na direção certa
 *   e no valor da transação; LOSS, REJECTED e PENDING_REFERENCE não têm lançamento;
 * - toda transação gravada tem os eventos do seu estado na outbox.
 * Devolve a lista de violações (vazia quando está tudo certo).
 */
export async function checkInvariants(orm: MikroORM): Promise<InvariantViolation[]> {
  const conn = orm.em.getConnection();
  const violations: InvariantViolation[] = [];

  const wallets = await conn.execute<
    { wallet_id: string; balance: string; ledger_balance: string; version: number; movements: number }[]
  >(`
    select w.id as wallet_id,
           w.balance,
           coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(18,2)::text
             as ledger_balance,
           w.version,
           count(e.id) filter (where t.kind <> 'OPENING')::int as movements
      from wallets w
      left join wallet_ledger_entries e on e.wallet_id = w.id
      left join wager_transactions t on t.id = e.transaction_id
     group by w.id
  `);
  for (const w of wallets) {
    if (w.balance !== w.ledger_balance) {
      violations.push({ walletId: w.wallet_id, rule: 'saldo = ledger', detail: `${w.balance} != ${w.ledger_balance}` });
    }
    if (w.version !== 1 + w.movements) {
      violations.push({ walletId: w.wallet_id, rule: 'version = 1 + movimentos', detail: `${w.version} != 1 + ${w.movements}` });
    }
  }

  const chain = await conn.execute<{ wallet_id: string; id: string }[]>(`
    select wallet_id, id from (
      select wallet_id, id, balance_before,
             coalesce(lag(balance_after) over (partition by wallet_id order by wallet_version), 0) as previous_after
        from wallet_ledger_entries
    ) e
    where balance_before <> previous_after
  `);
  for (const c of chain) {
    violations.push({ walletId: c.wallet_id, rule: 'ledger encadeado', detail: `lançamento ${c.id}` });
  }

  const transactions = await conn.execute<{ wallet_id: string; id: string; problem: string }[]>(`
    select t.wallet_id, t.id,
           case
             when t.status = 'PROCESSED' and t.kind <> 'LOSS'
                  and not (count(e.id) = 1 and bool_and(e.amount = t.amount and e.direction = case
                             when t.kind in ('OPENING', 'WIN', 'REFUND') then 'CREDIT'
                             when t.kind = 'BET' then 'DEBIT'
                             else (select case r.kind when 'BET' then 'CREDIT' else 'DEBIT' end
                                     from wager_transactions r where r.id = t.reference_transaction_id)
                           end))
               then 'transação processada sem exatamente um lançamento correto'
             when (t.status <> 'PROCESSED' or t.kind = 'LOSS') and count(e.id) > 0
               then 'transação sem efeito no saldo com lançamento'
             when not exists (
                    select 1 from outbox_messages o
                     where o.payload -> 'data' ->> 'transactionId' = t.id::text
                       and o.event_type = case t.status
                             when 'PROCESSED' then 'WagerTransactionProcessed'
                             when 'REJECTED' then 'WagerTransactionRejected'
                             when 'PENDING_REFERENCE' then 'WagerTransactionPendingReference'
                           end)
               then 'transação sem o evento do seu estado na outbox'
             when t.status = 'PROCESSED' and t.kind <> 'LOSS' and (
                    select count(*) from outbox_messages o
                     where o.event_type = 'WalletBalanceChanged'
                       and o.payload -> 'data' ->> 'transactionId' = t.id::text) <> 1
               then 'movimento sem exatamente um WalletBalanceChanged'
           end as problem
      from wager_transactions t
      left join wallet_ledger_entries e on e.transaction_id = t.id
     where t.status <> 'FAILED'
     group by t.id
  `);
  for (const t of transactions) {
    if (t.problem) violations.push({ walletId: t.wallet_id, rule: t.problem, detail: `transação ${t.id}` });
  }

  return violations;
}
