import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ormOptions } from '../../src/mikro-orm.config';
import { migrations } from '../../src/migrations';
import { testConfig } from '../support/test-config';

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

async function executedNames(): Promise<string[]> {
  return (await orm.migrator.getExecuted()).map((m) => m.name);
}

beforeAll(async () => {
  orm = await MikroORM.init(ormOptions(testConfig().db));
  await orm.migrator.down({ to: 0 });
});

afterAll(async () => {
  // Deixa o banco de testes migrado para as próximas suítes.
  await orm.migrator.up();
  await orm.close(true);
});

describe('migrations', () => {
  test('up aplica todas as migrations em ordem', async () => {
    expect(await executedNames()).toEqual([]);
    await orm.migrator.up();
    expect(await executedNames()).toEqual(migrations.map((m) => m.name));
    expect(await databaseTimezone()).toBe('UTC');
  });

  test('down reverte a última migration e up a reaplica', async () => {
    await orm.migrator.down();
    expect(await executedNames()).toEqual(migrations.slice(0, -1).map((m) => m.name));
    expect(await databaseTimezone()).toBeNull();

    await orm.migrator.up();
    expect(await executedNames()).toEqual(migrations.map((m) => m.name));
  });
});
