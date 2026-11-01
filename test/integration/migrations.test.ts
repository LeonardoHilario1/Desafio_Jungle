import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/dominio/dinheiro';
import { Wallet } from '../../src/dominio/carteira';
import { migrations } from '../../src/migracoes';
import { MikroOrmWageringUnitOfWork } from '../../src/persistencia/repositorio-apostas-mikro-orm';
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
const domainTables = ['outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

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

  test('down é recusado quando há dados financeiros', async () => {
    const opened = Wallet.open({ playerId: 'p', initialBalance: Money.from({ amount: '10', currency: 'BRL' }) });
    await new MikroOrmWageringUnitOfWork(orm).run((store) => store.insertWallet(opened, []));

    // allOrNothing: a falha em um down desfaz também o down das migrations posteriores.
    await expect(orm.migrator.down({ to: 0 })).rejects.toThrow('down recusado');
    expect(await executedNames()).toEqual(allNames);
    expect(await tables()).toEqual(domainTables);
  });

});
