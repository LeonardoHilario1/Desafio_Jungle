import { MikroORM } from '@mikro-orm/postgresql';
import { loadDatabaseConfig } from './config';
import { ormOptions } from './mikro-orm.config';

// Uso: bun src/migrate.ts up | down
// "down" reverte apenas a última migration executada.
// Roda como passo separado (serviço "migrate" no Compose), nunca na subida da
// aplicação, para que várias instâncias não migrem ao mesmo tempo.
const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('Uso: bun src/migrate.ts up|down');
  process.exit(2);
}

const orm = await MikroORM.init(ormOptions(loadDatabaseConfig()));
try {
  const executed = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  const names = executed.map((m) => m.name);
  console.log(`migration:${direction} ->`, names.length > 0 ? names.join(', ') : 'nada a fazer');
} finally {
  await orm.close(true);
}
