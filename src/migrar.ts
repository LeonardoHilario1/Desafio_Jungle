import { MikroORM } from '@mikro-orm/postgresql';
import { loadDatabaseConfig } from './configuracao';
import { ormOptions } from './configuracao-orm';

// uso: bun src/migrar.ts up | down
// o down desfaz só a última migration executada.
// roda como passo separado (serviço "migrate" no Compose), nunca na subida da aplicação,
// pra várias instâncias não tentarem migrar ao mesmo tempo
const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('Uso: bun src/migrar.ts up|down');
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
