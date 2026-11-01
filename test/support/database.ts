import { expect } from 'bun:test';
import type { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { ormOptions } from '../../src/mikro-orm.config';
import { testConfig } from './test-config';

export async function initTestOrm(): Promise<MikroORM> {
  return MikroORM.init(ormOptions(testConfig().db));
}

/**
 * Volta o banco de testes ao estado "nenhuma migration aplicada" e, por padrão,
 * aplica todas de novo. O ledger bloqueia DELETE e TRUNCATE por trigger, então limpar
 * dados só é possível descartando as tabelas (DROP não dispara esses triggers).
 *
 * A tabela de controle do Migrator é preservada e só esvaziada: o Migrator guarda em
 * cache, num campo privado, que ela existe, e não a recriaria se fosse descartada.
 * Use só no banco de testes.
 */
export async function resetDatabase(orm: MikroORM, options: { migrate: boolean } = { migrate: true }): Promise<void> {
  const connection = orm.em.getConnection();
  const [row] = await connection.execute<{ db: string }[]>('select current_database() as db');
  if (!row?.db.endsWith('_test')) {
    throw new Error(`resetDatabase recusado fora do banco de testes: ${row?.db}`);
  }
  await (orm.migrator as Migrator).getStorage().ensureTable();
  await connection.execute(`
    do $$
    declare
      obj record;
    begin
      for obj in select tablename from pg_tables
                  where schemaname = 'public' and tablename <> 'mikro_orm_migrations' loop
        execute format('drop table if exists public.%I cascade', obj.tablename);
      end loop;
      for obj in select p.oid::regprocedure as fn from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' loop
        execute format('drop function if exists %s cascade', obj.fn);
      end loop;
      delete from public.mikro_orm_migrations;
      execute format('alter database %I reset timezone', current_database());
    end
    $$;
  `);
  if (options.migrate) {
    await orm.migrator.up();
  }
}

/** Espera que a operação falhe com o SQLSTATE informado (e, opcionalmente, a constraint). */
export async function expectSqlState(
  operation: Promise<unknown>,
  sqlState: string,
  constraint?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const error = caught as { code?: string; constraint?: string; message?: string };
  expect({ code: error.code, message: error.message }).toMatchObject({ code: sqlState });
  if (constraint !== undefined) {
    expect(error.constraint ?? error.message).toContain(constraint);
  }
}
