import type { MikroORM } from '@mikro-orm/postgresql';

export interface InvariantViolation {
  walletId: string;
  rule: string;
  detail: string;
}

/**
 * Confere, direto no banco, as invariantes financeiras de todas as carteiras:
 * - saldo da carteira = saldo reconstruído pelo ledger (créditos - débitos);
 * - version = 1 + número de lançamentos (cada mudança de saldo incrementa uma vez);
 * - BET e WIN processadas têm exatamente um lançamento, na direção certa e no valor
 *   da transação; LOSS, REJECTED e PENDING_REFERENCE não têm lançamento;
 * - toda transação gravada tem exatamente um evento no outbox.
 * Devolve a lista de violações (vazia quando está tudo certo).
 */
export async function checkInvariants(orm: MikroORM): Promise<InvariantViolation[]> {
  const conn = orm.em.getConnection();
  const violations: InvariantViolation[] = [];

  const wallets = await conn.execute<
    { wallet_id: string; balance: string; ledger_balance: string; version: number; entries: number }[]
  >(`
    select w.id as wallet_id,
           w.balance,
           coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(18,2)::text
             as ledger_balance,
           w.version,
           count(e.id)::int as entries
      from wallets w
      left join wallet_ledger_entries e on e.wallet_id = w.id
     group by w.id
  `);
  for (const w of wallets) {
    if (w.balance !== w.ledger_balance) {
      violations.push({ walletId: w.wallet_id, rule: 'saldo = ledger', detail: `${w.balance} != ${w.ledger_balance}` });
    }
    if (w.version !== 1 + w.entries) {
      violations.push({ walletId: w.wallet_id, rule: 'version = 1 + lançamentos', detail: `${w.version} != 1 + ${w.entries}` });
    }
  }

  const transactions = await conn.execute<{ wallet_id: string; id: string; problem: string }[]>(`
    select t.wallet_id, t.id,
           case
             when t.status = 'PROCESSED' and t.type = 'BET'
                  and not (count(e.id) = 1 and bool_and(e.direction = 'DEBIT' and e.amount = t.amount))
               then 'BET processada sem exatamente um débito do valor'
             when t.status = 'PROCESSED' and t.type = 'WIN'
                  and not (count(e.id) = 1 and bool_and(e.direction = 'CREDIT' and e.amount = t.amount))
               then 'WIN processada sem exatamente um crédito do valor'
             when (t.status <> 'PROCESSED' or t.type = 'LOSS') and count(e.id) > 0
               then 'transação sem efeito no saldo com lançamento'
             when (select count(*) from outbox_events o where o.aggregate_id = t.id) <> 1
               then 'transação sem exatamente um evento no outbox'
           end as problem
      from wager_transactions t
      left join wallet_ledger_entries e on e.transaction_id = t.id
     group by t.id
  `);
  for (const t of transactions) {
    if (t.problem) violations.push({ walletId: t.wallet_id, rule: t.problem, detail: `transação ${t.id}` });
  }

  return violations;
}
