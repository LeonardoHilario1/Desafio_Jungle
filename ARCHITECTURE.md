# Arquitetura

Documento vivo, atualizado a cada etapa. As decisões de domínio (lock pessimista,
idempotência, outbox, estados) estão definidas no `SPEC.md` e são detalhadas aqui à
medida que forem implementadas.

## Etapa 1: base

### Infraestrutura

- **Docker Compose** com `postgres` (16), `localstack` (SQS), `migrate` e `app`.
- **Migrations como passo separado.** O serviço `migrate` roda `bun src/migrate.ts up` e
  termina; o `app` só sobe depois (`service_completed_successfully`). A aplicação nunca
  migra na subida: com várias instâncias, todas tentariam migrar ao mesmo tempo.
- **LocalStack fixado em 4.4**, porque versões mais novas exigem token de conta. A fila
  `wagering-events` é **padrão (não FIFO)**: a correção não depende de ordem nem de
  entrega única do SQS (restrição 3); quem garante é o banco.

### MikroORM 7

- **Migrations listadas explicitamente** (`migrations.migrationsList`) em vez de descoberta
  por glob, para funcionar igual no Bun local, no container e nos testes.
- **Migrations escritas à mão em SQL**, com `up` e `down`. O snapshot do gerador está
  desligado, porque constraints como CHECK, triggers de imutabilidade e índices parciais
  são melhor expressas em SQL explícito.
- `transactional` e `allOrNothing` ligados: um lote de migrations entra inteiro ou não entra.
- **Metadados sem reflection.** O MikroORM 7 usa por padrão um `MetadataProvider` que não
  lê `design:type`. As entidades (Etapa 2) vão declarar o tipo de cada coluna
  explicitamente. `emitDecoratorMetadata` continua ligado só para a injeção de dependência
  do NestJS, e mesmo assim os construtores usam `@Inject(...)` explícito para não depender
  disso.
- **Migration de base** (`Migration20261031000000_baseline`): fixa o fuso do banco em UTC.
  O objetivo principal é validar o pipeline de subida e reversão; as tabelas do domínio
  chegam na Etapa 3.

### Health checks

- `GET /health/live`: não toca em dependências. Reiniciar o processo não resolve um
  banco fora do ar, então o liveness não deve falhar por isso.
- `GET /health/ready`: `select 1` no PostgreSQL e `GetQueueUrl` da fila do outbox, em
  paralelo e com timeout de 2 s cada. Responde 503 com o resultado de cada check.
- Implementado com um controller simples, sem `@nestjs/terminus`.

### Configuração

Variáveis de ambiente validadas na subida (`src/config.ts`): faltou alguma, o processo
não sobe. O `AppModule` recebe a configuração por parâmetro (`AppModule.register`), o
que permite aos testes apontar para o banco de testes sem mexer em `process.env`.

### Testes

`bun test`. Os de integração usam PostgreSQL e LocalStack reais do Compose, com um banco
dedicado `wagering_test` (restrição 10).

## Limitações conhecidas (até aqui)

- O Migrator do MikroORM 7.2 não usa advisory lock (conferido no código do pacote), então
  duas execuções simultâneas do `migrate` não são seguras. O Compose roda uma única
  instância dele. Em produção, isso seria um job único no deploy.
- Autenticação, métricas e o restante listado como fora de escopo no `SPEC.md` serão
  documentados na Etapa 7.
