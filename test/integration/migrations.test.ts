import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { migrations } from '../../src/migrations';
import { initTestOrm, resetDatabase } from '../support/database';

let orm: MikroORM;

async function databaseTimezone(): Promise<string | null> {
  const rows = await orm.em.getConnection().execute<{ setconfig: string[] }[]>(
    `select s.setconfig
       from pg_db_role_setting s
       join pg_database d on d.oid = s.setdatabase
      where d.datname = current_database() and s.setrole = 0`,
  );
  const entry = rows[0]?.setconfig.find((c) => c.startsWith('TimeZone='));
  return entry ? entry.slice('TimeZone='.length) : null;
}

async function tables(): Promise<string[]> {
  const rows = await orm.em.getConnection().execute<{ table_name: string }[]>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
      order by table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function executedNames(): Promise<string[]> {
  return (await orm.migrator.getExecuted()).map((m) => m.name);
}

const allNames = migrations.map((m) => m.name);
const domainTables = ['wager_transactions', 'wallet_ledger_entries', 'wallets'];

beforeAll(async () => {
  orm = await initTestOrm();
  await resetDatabase(orm, { migrate: false });
});

afterAll(async () => {
  // Deixa o banco de testes limpo e migrado para as próximas suítes.
  await resetDatabase(orm);
  await orm.close(true);
});

describe('migrations', () => {
  test('up aplica todas as migrations em ordem', async () => {
    expect(await executedNames()).toEqual([]);
    await orm.migrator.up();
    expect(await executedNames()).toEqual(allNames);
    expect(await tables()).toEqual(domainTables);
    expect(await databaseTimezone()).toBe('UTC');
  });

  test('down reverte tudo e up reaplica', async () => {
    await orm.migrator.down({ to: 0 });
    expect(await executedNames()).toEqual([]);
    expect(await tables()).toEqual([]);
    expect(await databaseTimezone()).toBeNull();

    await orm.migrator.up();
    expect(await executedNames()).toEqual(allNames);
    expect(await tables()).toEqual(domainTables);
  });

  test('down do schema é recusado quando o ledger tem lançamentos', async () => {
    const conn = orm.em.getConnection();
    await conn.execute(`insert into wallets (id, player_id, currency, balance) values
                        ('00000000-0000-0000-0000-000000000001', 'p', 'BRL', 0)`);
    await conn.execute(`insert into wager_transactions
                          (id, idempotency_key, payload_hash, wallet_id, type, currency, amount, status)
                        values ('00000000-0000-0000-0000-000000000002', 'k', repeat('a', 64),
                                '00000000-0000-0000-0000-000000000001', 'BET', 'BRL', 10, 'PENDING')`);
    await conn.execute(`insert into wallet_ledger_entries
                          (id, wallet_id, transaction_id, direction, currency, amount, balance_after)
                        values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
                                '00000000-0000-0000-0000-000000000002', 'CREDIT', 'BRL', 10, 10)`);

    await expect(orm.migrator.down()).rejects.toThrow('down recusado');
    expect(await executedNames()).toEqual(allNames);
    expect(await tables()).toEqual(domainTables);
  });
});
