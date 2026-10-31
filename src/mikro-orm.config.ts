import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { DatabaseConfig } from './config';
import { migrations } from './migrations';

export function ormOptions(db: DatabaseConfig) {
  return defineConfig({
    driver: PostgreSqlDriver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    dbName: db.name,
    entities: [],
    // Ainda não há entidades na Etapa 1.
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: migrations,
      transactional: true,
      allOrNothing: true,
      // Migrations são escritas à mão em SQL; o snapshot do gerador não é usado.
      snapshot: false,
      snapshotOnMigrate: false,
    },
  });
}
