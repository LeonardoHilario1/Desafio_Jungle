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

## Etapa 2: domínio

Classes em `src/domain`, sem dependência de framework, todas com construtor privado e
factories estáticas. O MikroORM reconstrói entidades lidas do banco com
`Object.create(prototype)`, sem chamar o construtor, então isso não atrapalha o
mapeamento (Etapa 3).

### Money

- Guarda centavos em `bigint`. Entrada e saída são strings decimais com escala 2
  (`"10.50"`); `number` não entra em nenhum ponto.
- Valida no formato: até 16 dígitos inteiros e 2 decimais (o intervalo de
  `numeric(18,2)`), sem sinal, expoente, espaços ou zeros à esquerda. `"10"` e `"10.5"`
  são aceitos e normalizados.
- **Não negativo.** Subtração com resultado negativo e estouro do intervalo lançam
  `AMOUNT_OUT_OF_RANGE`.
- Operações com moedas diferentes lançam `CURRENCY_MISMATCH`.
- Imutável: `Object.freeze` e operações que devolvem nova instância.
- Moeda: código ISO 4217 de 3 letras maiúsculas, sempre com escala 2. Moedas com outra
  escala (JPY, BHD) ficam fora do MVP.

### Wallet

- O saldo só muda por `debit` e `credit`. Cada um valida moeda e saldo, incrementa
  `version` e **devolve o `WalletLedgerEntry` correspondente**. Toda mudança de saldo
  tem exatamente um lançamento, por construção.
- A exclusão mútua entre requisições concorrentes não é papel da classe; fica com o
  `SELECT ... FOR UPDATE` na Etapa 4.

### WalletLedgerEntry

Todos os campos são `readonly`. Guarda `amount` e `balanceAfter`, o que permite
reconstruir e conferir o saldo pelo ledger.

### WagerTransaction

**Decisão de domínio (o SPEC não detalha o payload):**

| Tipo | Valor   | `referenceKey`                         | Efeito no saldo |
| ---- | ------- | -------------------------------------- | --------------- |
| BET  | > 0     | proibida                               | débito          |
| WIN  | > 0     | obrigatória: chave de idempotência da BET | crédito      |
| LOSS | `0.00`  | obrigatória: chave de idempotência da BET | nenhum (só liquida a aposta) |

- A referência usa a **chave de idempotência da BET**, porque é o identificador que o
  provedor conhece. Nossos UUIDs ele não conhece.
- Se a BET referenciada ainda não chegou (entrega fora de ordem), a WIN/LOSS fica em
  `PENDING_REFERENCE`. O reprocessamento com backoff está fora do escopo.
- `linkReference(bet)` valida o vínculo e devolve um `failureCode` quando ele é
  inválido: a referência não é BET, é de outra carteira, de outra moeda, ou a BET não
  foi processada. A regra "uma BET só é liquidada uma vez" depende de outras linhas,
  então fica com um índice único parcial no banco (Etapa 3).
- **Estados.** PENDING pode ir para qualquer outro. PENDING_REFERENCE (só WIN/LOSS) pode
  ir para PROCESSED, REJECTED ou FAILED. Os terminais não mudam mais. WIN/LOSS só vira
  PROCESSED depois de vinculada à BET.
- **`payloadHash`.** SHA-256 do JSON canônico (chaves ordenadas) de `walletId`, `type`,
  `amount` normalizado, `currency` e `referenceKey`. A chave de idempotência fica de fora,
  porque é a identidade da requisição, não o conteúdo. Como o valor entra normalizado,
  `"10"` e `"10.00"` geram o mesmo hash.

### Erros

`DomainError` sempre carrega um `code` estável. Os códigos em `FAILURE_CODES` podem ser
gravados como `failureCode` de uma transação; os demais (`INVALID_AMOUNT`,
`INVALID_TRANSACTION`, ...) indicam entrada inválida e viram 4xx na API.

## Etapa 3: schema

### Mapeamento ORM (`src/persistence/entity-schemas.ts`)

- `EntitySchema` sem decorators, com `type` e `columnType` explícitos em toda coluna.
- O `EntitySchema` tipado exige mapear toda propriedade pública e não enxerga campos
  privados. Por isso as classes de domínio guardam o estado persistido em campos
  privados com tipos primitivos (por exemplo `balanceAmount: string`) e expõem `Money`
  e o estado por **métodos** (`wallet.balance()`, `tx.status()`).
- Tipos `*Row` descrevem os campos persistidos. O cast em `class` é o único ponto em
  que a tipagem é contornada.
- `numeric(18,2)` é lido e gravado como `string`: o driver `pg` devolve numeric como
  string, e o domínio converte para `Money`.
- **Sem relações ORM** (as FKs são colunas uuid escalares). Isso deixa o mapeamento
  simples e evita carregamento implícito. A contrapartida é que o ORM não ordena os
  inserts pelas FKs: o código grava na ordem carteira → transação → lançamento.

### Constraints (migration `Migration20261101000000_wagering_schema`)

| Regra | Como o banco garante |
| --- | --- |
| Uma carteira por jogador e moeda | `UNIQUE (player_id, currency)` |
| Saldo não negativo | `CHECK (balance >= 0)`; no ledger, `amount > 0` e `balance_after >= 0` |
| Idempotência | `UNIQUE (idempotency_key)` |
| Um lançamento por transação (replay nunca debita duas vezes) | `UNIQUE (transaction_id)` no ledger |
| Uma liquidação por BET | índice único parcial em `reference_transaction_id` `WHERE status = 'PROCESSED' AND type IN ('WIN','LOSS')` |
| Moeda da transação e do lançamento = moeda da carteira | FK composta `(wallet_id, currency) → wallets (id, currency)` |
| Lançamento e transação da mesma carteira | FK composta `(transaction_id, wallet_id) → wager_transactions (id, wallet_id)` |
| BET liquidada da mesma carteira | FK composta `(reference_transaction_id, wallet_id) → wager_transactions (id, wallet_id)` |
| Forma por tipo (BET/WIN/LOSS) | `CHECK` combinando `type`, `amount` e `reference_key` |
| Coerência de estado | `CHECK`s: `failure_code` só em REJECTED/FAILED; `processed_at` só em terminais; WIN/LOSS só PROCESSED com referência |
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Transação imutável | trigger bloqueia `DELETE`/`TRUNCATE`, alteração de campos de negócio e qualquer mudança após estado terminal |

Os erros dos triggers usam SQLSTATE `P0001`, com `hint` `LEDGER_IMMUTABLE` ou
`TRANSACTION_IMMUTABLE`.

### Reversibilidade

O `down` da migration de schema apaga as tabelas, mas **recusa rodar se o ledger tiver
lançamentos**. Assim, um down acidental num ambiente com dados falha em vez de destruir
o histórico financeiro.

### Testes

`test/integration/schema.test.ts` exercita cada constraint com SQL direto e confere o
SQLSTATE e o nome da constraint. Também cobre a ida e volta pelo ORM (Money em string,
`version`). Como o ledger bloqueia `DELETE`/`TRUNCATE`, o reset entre testes descarta e
recria as tabelas.

## Etapa 4: API

### Saldo inicial (decisão tomada com o responsável)

O SPEC não define como uma carteira recebe saldo, e sem isso nenhuma BET é processada.
Decisão: `POST /wallets` aceita `initialBalance` opcional. Ele entra no ledger como um
lançamento **de abertura** (`kind = 'OPENING'`): CREDIT, sem transação de aposta, no
máximo um por carteira (migration `Migration20261101010000_opening_balance`). Assim,
saldo = soma do ledger vale desde a criação. Depósitos posteriores ficam fora do MVP.

### Processamento de `POST /wagering/transactions`

Tudo numa única transação de banco (`READ COMMITTED`):

1. `set local lock_timeout = '5s'`.
2. `SELECT ... FOR UPDATE` na carteira. Requisições para a mesma carteira são
   serializadas aqui; carteiras diferentes não disputam lock entre si.
3. Com o lock na mão, busca a `Idempotency-Key`. Em `READ COMMITTED` cada comando vê
   o que já foi commitado, então uma requisição concorrente com a mesma chave, que pegou
   o lock antes, já está visível. Mesmo `payloadHash` vira replay; hash diferente vira 409.
4. Aplica a regra:
   - BET: debita se houver saldo; senão grava REJECTED/`INSUFFICIENT_FUNDS`.
   - WIN/LOSS: procura a BET pela chave. Se ainda não chegou, grava PENDING_REFERENCE.
     Se não puder liquidar (BET rejeitada, de outra carteira, já liquidada), grava REJECTED.
     Senão, WIN credita, LOSS só liquida.
5. Grava transação, saldo (com `version` + 1) e lançamento, e faz commit.

**Mesma chave em carteiras diferentes ao mesmo tempo.** O lock por carteira não
serializa esse caso. O `UNIQUE (idempotency_key)` barra o segundo insert, e o resultado
é decidido relendo o registro vencedor (replay ou 409).

**Não persistidos (nada muda, e repetir é seguro):** entrada inválida (400), carteira
inexistente (404), moeda diferente da carteira (422 `CURRENCY_MISMATCH`, porque a FK
composta não permitiria gravar), timeout de lock (503 `WALLET_BUSY`) e erro inesperado
(500). Esses casos não consomem a chave de idempotência.

### Status HTTP

| Situação | Status | Corpo |
| --- | --- | --- |
| PROCESSED | 201 | transação |
| PENDING_REFERENCE | 202 | transação |
| REJECTED (regra de negócio, gravada) | 422 | transação com `failureCode` |
| Replay | o mesmo da primeira resposta | o mesmo, com header `Idempotent-Replayed: true` |
| Mesma chave, payload diferente | 409 `IDEMPOTENCY_KEY_CONFLICT` | erro |
| Entrada inválida / header ausente | 400 | erro |
| Carteira inexistente | 404 `WALLET_NOT_FOUND` | erro |
| Moeda diferente da carteira | 422 `CURRENCY_MISMATCH` | erro |
| Carteira duplicada (jogador+moeda) | 409 `WALLET_ALREADY_EXISTS`, com `details.walletId` | erro |
| Lock não obtido em 5 s | 503 `WALLET_BUSY` | erro |

O status deriva só do estado gravado, por isso o replay reproduz a resposta original.
Erros têm o formato `{ "error": { "code", "message", "details"? } }`.

**FAILED.** Este endpoint não produz FAILED. Uma falha inesperada desfaz a transação
inteira (500) e o cliente pode repetir com a mesma chave. Gravar FAILED tornaria uma falha
transitória definitiva. O estado fica reservado para processamento assíncrono (consumidor
e reprocessamento), fora do MVP.

### Validação de entrada

Manual (`src/api/request.ts`), sem `class-validator`: tipo dos campos e rejeição de
campos desconhecidos. As regras de valor ficam no domínio. `amount` precisa ser string;
`10` como number é 400.

### Autenticação

`AuthGuard` sem efeito, aplicado aos controllers de carteira e de apostas como ponto de
extensão (desenho na Etapa 7).

## Limitações conhecidas (até aqui)

- Transações em PENDING_REFERENCE não são reprocessadas quando a BET chega depois.
  Replay da mesma chave devolve o PENDING_REFERENCE gravado.
- Sem depósitos depois da abertura.

- Os triggers não protegem contra o **dono** das tabelas, que pode desabilitá-los, nem
  contra `DROP`. Em produção, a aplicação usaria uma role sem ownership, com só
  `INSERT`/`SELECT` no ledger. No MVP, aplicação e migrations usam o mesmo usuário.

- Todas as moedas usam escala 2.

- O Migrator do MikroORM 7.2 não usa advisory lock (conferido no código do pacote), então
  duas execuções simultâneas do `migrate` não são seguras. O Compose roda uma única
  instância dele. Em produção, isso seria um job único no deploy.
- Autenticação, métricas e o restante listado como fora de escopo no `SPEC.md` serão
  documentados na Etapa 7.
