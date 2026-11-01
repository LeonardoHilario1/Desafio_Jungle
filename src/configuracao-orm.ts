import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { DatabaseConfig } from './configuracao';
import { migrations } from './migracoes';
import { entitySchemas } from './persistencia/esquemas-entidades';

export function ormOptions(db: DatabaseConfig) {
  return defineConfig({
    driver: PostgreSqlDriver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    dbName: db.name,
    entities: entitySchemas,
    extensions: [Migrator],
    migrations: {
      migrationsList: migrations,
      transactional: true,
      allOrNothing: true,
      // as migrations eu escrevo na mão em SQL, então não uso o snapshot do gerador
      snapshot: false,
      snapshotOnMigrate: false,
    },
  });
}
