# Arquitetura

Decisões, trade-offs e limitações do Distributed Wagering Processor. O escopo inicial
está no [SPEC.md](SPEC.md); a partir da Etapa 8, o contrato segue o enunciado completo
do desafio. Setup e comandos estão no [README.md](README.md).

## Sumário

1. [Visão geral](#visão-geral)
2. [Conformidade com as restrições invioláveis](#conformidade-com-as-restrições-invioláveis)
3. [ORM, mapeamento do Money e estratégia transacional](#orm-mapeamento-do-money-e-estratégia-transacional)
4. [Modelo de domínio](#modelo-de-domínio)
5. [Regras de negócio](#regras-de-negócio)
6. [Códigos de falha](#códigos-de-falha)
7. [Concorrência e idempotência](#concorrência-e-idempotência)
8. [Schema e garantias no banco](#schema-e-garantias-no-banco)
9. [API](#api)
10. [Eventos e outbox](#eventos-e-outbox)
11. [Infraestrutura e operação](#infraestrutura-e-operação)
12. [Testes](#testes)
13. [Autenticação (desenho, não implementado)](#autenticação-desenho-não-implementado)
14. [Trade-offs](#trade-offs)
15. [Limitações e pendências](#limitações-e-pendências)
16. [Quem decidiu o quê](#quem-decidiu-o-quê)

## Visão geral

```
provedor ──HTTP──▶ NestJS (N instâncias) ──▶ ProcessWagerTransaction (caso de uso)
                                               │ uma transação SQL:
                                               │ lock da carteira → idempotência → referência →
                                               │ regras → transação + saldo + ledger + outbox
                                               ▼
                                            PostgreSQL ◀── OutboxPublisher (cada instância, SKIP LOCKED)
                                                                  │
                                                                  ▼
                                                          SQS wagering-events
```

- **A correção depende do PostgreSQL**, não do processo nem da fila: lock, unicidade,
  não negatividade, aritmética do ledger e imutabilidade estão no banco.
- **Instâncias sem estado:** qualquer número delas pode rodar ao mesmo tempo.
- **Nenhum evento sai antes do commit:** ele é gravado na mesma transação e só depois
  publicado.

Os nomes de pastas e arquivos em `src` estão em português. Os identificadores no código
(classes, métodos, campos) continuam em inglês, iguais aos do enunciado do desafio
(`Money`, `Wallet`, `WagerTransaction`...), para facilitar a comparação.

| Pasta | Conteúdo |
| --- | --- |
| `src/dominio` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, regras (`regras-aposta.ts`), eventos de integração, `OutboxMessage`. Sem dependência de ORM nem de NestJS. |
| `src/aplicacao` | casos de uso (`ProcessWagerTransaction`, `OpenWallet`, `WageringQueries`), a porta `WageringStore`/`WageringUnitOfWork` e os erros de aplicação |
| `src/persistencia` | records do MikroORM (`EntitySchema`), mappers record ↔ domínio, implementação da porta, tradução de erros do banco |
| `src/migracoes` | migrations SQL versionadas e reversíveis |
| `src/carteiras`, `src/apostas` | controllers e presenters HTTP |
| `src/outbox` | publisher e worker |
| `src/api`, `src/autenticacao`, `src/saude` | validação de entrada e filtro de erros, guard de autenticação, health checks |

## Conformidade com as restrições invioláveis

| # | Restrição | Como é atendida | Evidência |
| --- | --- | --- | --- |
| 1 | Nada de `number`/`float`/`double` para dinheiro | `Money` guarda centavos em `bigint`; entrada e saída em string de escala 2. Colunas `numeric(18,2)` lidas e gravadas como string. A API rejeita `amount` numérico. | `dinheiro.ts`, `mapeadores.ts`. Testes: `money.test.ts`, `wagering-api.test.ts` ("money numérico"). |
| 2 | Idempotência não fica em memória | Chave e `payloadHash` em `wager_transactions`, com `UNIQUE (idempotency_key)`; busca no banco sob o lock da carteira. | `processar-transacao-aposta.ts`; replay entre **3 instâncias** em `concurrency.test.ts` |
| 3 | Não confiar só em SQS FIFO | A fila de eventos é padrão. A consistência vem do banco; o evento leva `eventId` determinístico (deduplicação) e `walletVersion` (ordenação). | `evento-integracao.ts` |
| 4 | Não publicar antes do commit | Outbox gravada na mesma transação; o publisher só lê linhas commitadas. | "não publica mensagem de transação ainda não commitada" (`outbox.test.ts`) |
| 5 | Ledger nunca sobrescrito nem excluído | Trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE`; o `down` recusa rodar com lançamentos. | `Migration20261102010000_ledger.ts`; `schema.test.ts`, `migrations.test.ts` |
| 6 | Sem lock global | `SELECT ... FOR UPDATE` só na linha da carteira; nenhum advisory lock nem `LOCK TABLE`. | `repositorio-apostas-mikro-orm.ts` |
| 7 | Sem ler → calcular → gravar sem controle | Saldo lido com `FOR UPDATE` na mesma transação da escrita; `CHECK (balance >= 0)` e `UNIQUE (wallet_id, wallet_version)` no ledger como redes. | Sem o lock, 13 dos 16 testes de concorrência falham |
| 8 | Correto com várias instâncias | Nada de estado no processo. Os testes de concorrência sobem **três** aplicações com pools separados; a outbox usa `SKIP LOCKED`. | `concurrency.test.ts`; 4 publishers em `outbox.test.ts` |
| 9 | Garantias no schema | `UNIQUE`, `CHECK`, FKs compostas, índices únicos parciais e triggers. | [Schema](#schema-e-garantias-no-banco); um teste por constraint em `schema.test.ts` |

## ORM, mapeamento do Money e estratégia transacional

- **MikroORM 7** (a opção preferencial): Unit of Work, Identity Map,
  `EntityManager.transactional()` e `LockMode` explícitos.
- **Domínio separado da persistência.** O MikroORM mapeia *records* (`WalletRecord`,
  `WagerTransactionRecord`, `LedgerEntryRecord`, `OutboxMessageRecord`), classes
  simples espelhando as tabelas, com `EntitySchema` sem decorators e `type` +
  `columnType` explícitos em toda coluna. Os mappers (`persistencia/mapeadores.ts`) convertem
  record → domínio pelas factories `rehydrate` e domínio → record copiando o estado para o
  record gerenciado; o Unit of Work gera o `UPDATE`.
  - **Por quê:** `Money` ocupa duas colunas (valor e moeda) e o domínio expõe estado só
    por getters sobre campos privados. Mapear as classes de domínio direto exigiria
    expor primitivos ou tipos do ORM no domínio, o que o desafio proíbe.
- **Mapeamento do Money:** valor em `numeric(18,2)` (lido como string pelo driver `pg`)
  e moeda em `char(3)`; reidratado com `Money.from`, que aceita exatamente a forma que o
  PostgreSQL devolve. Nenhum valor passa por `number`.
- **Estratégia transacional:** uma transação SQL por operação, `READ COMMITTED`, aberta
  pela porta `WageringUnitOfWork.run`. Dentro dela: `SET LOCAL lock_timeout = '5s'`, lock
  pessimista da carteira (`LockMode.PESSIMISTIC_WRITE` → `FOR UPDATE`) e gravação de
  transação, saldo, lançamento e outbox. Violações de `UNIQUE` e `lock_timeout` são
  traduzidas pela implementação da porta para erros que o caso de uso entende
  (`DuplicateTransactionError`, `LockTimeoutError`).
- **Ordem de gravação:** não há relações ORM (só colunas uuid), então os inserts são
  ordenados com flushes em sequência: carteira → transação → lançamento e outbox.

## Modelo de domínio

Todas as classes têm construtor privado e factories estáticas (`create`/`open`/`from`,
`rehydrate`). `rehydrate` reconstrói estado persistido sem revalidar transições.

### Money

- Centavos em `bigint`; entrada e saída como string decimal com escala fixa 2
  (`"10"` → `"10.00"`). Formato de contrato `{ "amount": "25.00", "currency": "BRL" }`.
- `from` rejeita `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas,
  negativos, sinal, espaços, zeros à esquerda e `number`. Não há arredondamento: um valor
  com terceira casa é rejeitado.
- Operações: `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`,
  `isLessThan`, `equals`, `toJSON`, `toString`. Valores negativos só surgem por operação
  (nunca por contrato de entrada) e quem grava garante não negatividade.
- Moedas diferentes lançam `CURRENCY_MISMATCH`. Imutável (`Object.freeze`).

### Wallet (aggregate root)

- `Wallet.open({ playerId, initialBalance })` devolve a carteira com **version 1** e, se o
  saldo inicial for maior que zero, a transação interna **OPENING** (já PROCESSED) e o
  lançamento CREDIT de 0 até o saldo inicial. Os três são gravados na mesma transação SQL.
- Getters `balance`, `version`, `updatedAt`. O saldo só muda por `debit`/`credit`, que
  validam moeda e saldo, incrementam `version` e **devolvem o lançamento**: saldo e
  ledger não divergem por construção.
- `version` começa em 1 e incrementa só quando o saldo muda. Não é usado para optimistic
  locking (a estratégia é pessimista); serve para ordenar o ledger e os eventos.

### WalletLedgerEntry

- Imutável estruturalmente (campos `readonly` e `Object.freeze`), sem transições.
- Guarda `money`, `balanceBefore`, `balanceAfter` e `walletVersion` (version da carteira
  depois do lançamento). `create` valida `isBalanced()` (`balanceBefore ± money =
  balanceAfter`), valor positivo e saldos não negativos.
- Uma transação gera no máximo um lançamento. LOSS e REJECTED não geram.

### WagerTransaction

- Campos do desafio: `providerId`, `externalTransactionId`, `idempotencyKey`,
  `payloadHash`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`,
  `referenceExternalTransactionId` (id **no provedor**), mais `correlationId` e o
  **saldo observado** (`observedBalance`), devolvido em todo replay.
- `create` nasce em `PENDING` e valida a forma por kind (tabela abaixo). OPENING não pode
  ser criada por `create`: só por `Wallet.open`.
- Getters `status`, `referenceTransactionId`, `failureCode`, `processedAt`,
  `observedBalance`. Consultas: `isTerminal`, `affectsBalance` (false para LOSS),
  `requiresReference` (REFUND e ROLLBACK), `matchesPayload`, `ledgerDirectionFor`.

**Transições válidas:**

```
PENDING ──▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──▶ PROCESSED | REJECTED | FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais. Tentar transicionar a partir deles
lança `InvalidTransactionStateError` (erro de programação). No banco, um trigger repete a
regra e impede voltar de `PENDING_REFERENCE` para `PENDING`. `PENDING` nunca é
commitado: a transação é gravada já no estado decidido.

## Regras de negócio

As regras ficam em `applyWager` (`src/dominio/regras-aposta.ts`), uma função pura: recebe a
carteira travada, a transação e o que foi lido do banco (a referência e se ela já foi
revertida), decide e executa a transição.

| Kind | Valor | Referência | Efeito no saldo | Ledger |
| --- | --- | --- | --- | --- |
| OPENING (interna) | > 0 | não | crédito | 1 CREDIT |
| BET | > 0 | proibida | débito | 1 DEBIT |
| WIN | > 0 | opcional: BET da mesma rodada | crédito | 1 CREDIT |
| LOSS | >= 0 | opcional: BET da mesma rodada | nenhum | nenhum |
| REFUND | = valor da referência | obrigatória: BET PROCESSED | crédito | 1 CREDIT |
| ROLLBACK | = valor da referência | obrigatória: BET, WIN ou REFUND PROCESSED | inverso da referência | 1 invertido |

Ordem das verificações:

1. moeda da operação = moeda da carteira; `playerId` = dono da carteira;
2. referência (se informada), resolvida por `(providerId, referenceExternalTransactionId)`:
   - ausente, ou ainda aberta → `PENDING_REFERENCE`;
   - REJECTED ou FAILED → `REFERENCE_NOT_PROCESSED`;
   - de outro jogador, carteira, moeda ou rodada → `REFERENCE_MISMATCH`;
   - de tipo não permitido → `REFERENCE_KIND_NOT_ALLOWED`;
3. reversões: valor igual ao da referência e nenhuma reversão anterior;
4. débito sem saldo → `INSUFFICIENT_FUNDS` (BET) ou `REVERSAL_INSUFFICIENT_FUNDS`
   (ROLLBACK de WIN ou REFUND).

**Interpretações adotadas** (o desafio pede que sejam documentadas):

- **Uma reversão por referência, de qualquer tipo.** O enunciado proíbe reverter a
  mesma referência duas vezes "pelo mesmo tipo de operação". Isso permitiria um REFUND e
  um ROLLBACK da mesma BET, creditando duas vezes. Aqui a referência é revertida no
  máximo uma vez (índice único parcial); a segunda tentativa é `REFERENCE_ALREADY_REVERSED`.
  Um ROLLBACK de um REFUND é permitido, porque a referência é outra.
- **BET não referencia nada; WIN e LOSS podem referenciar só BET.** WIN/LOSS sem
  referência são aceitas (o enunciado diz "pode referenciar").
- **LOSS aceita qualquer valor >= 0** e nunca move saldo.
- **Moeda ou jogador divergentes são gravados como REJECTED** (auditáveis, com evento),
  em vez de recusados sem registro. Por isso a FK de moeda está no ledger, não na
  transação.
- **Carteira inexistente** responde 404 sem gravar (não há carteira a que associar).

## Códigos de falha

Toda rejeição carrega um `failureCode` estável (`FAILURE_CODES` em `erro-dominio.ts`).
A coluna "provedor" diz o que fazer.

| `failureCode` | Situação | Provedor |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | BET acima do saldo | desistir; repetir dá o mesmo resultado |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de crédito que deixaria saldo negativo | escalar para operação (o crédito já foi consumido) |
| `CURRENCY_MISMATCH` | moeda diferente da carteira | corrigir o payload (nova chave) |
| `PLAYER_MISMATCH` | `playerId` diferente do dono da carteira | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite (Etapa 10) | conferir o id da referência |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência inválido para o kind | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência terminou REJECTED/FAILED | desistir |
| `REFERENCE_MISMATCH` | referência de outro jogador, carteira, moeda ou rodada | corrigir o payload |
| `REFERENCE_AMOUNT_MISMATCH` | valor da reversão diferente do da referência | corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | desistir; já foi feito |

`FAILED` usa `PROCESSING_FAILED` (`PERMANENT_FAILURE_CODES`), reservado para o consumidor
da fila (Etapa 10).

## Concorrência e idempotência

`ProcessWagerTransaction` (usado pela API e, na Etapa 10, pelo consumidor da fila) roda
em uma única transação SQL (`READ COMMITTED`):

1. `SET LOCAL lock_timeout = '5s'`.
2. `SELECT ... FOR UPDATE` na carteira. Operações da mesma carteira são serializadas em
   qualquer instância; carteiras diferentes não disputam lock.
3. **Com o lock**, busca a `Idempotency-Key`. Em `READ COMMITTED` cada comando enxerga o
   que já foi commitado, então a requisição concorrente que pegou o lock antes já está
   visível: mesmo `payloadHash` é replay; outro é 409. Mesmo
   `(providerId, externalTransactionId)` com outra chave também é 409.
4. Resolve a referência, aplica `applyWager` e grava transação, saldo, lançamento e
   eventos. Commit.

**Por que pessimista:** a operação é curta e sempre toca uma linha de carteira; o lock
evita retry por conflito, não tem deadlock (uma linha por transação) e torna trivial
raciocinar sobre a hot wallet. O custo é o throughput de uma carteira isolada (ver
[Trade-offs](#trade-offs)).

**Casos de borda:**

- **Mesma chave para carteiras diferentes ao mesmo tempo:** o lock por carteira não
  serializa esse caso. O `UNIQUE` barra o segundo insert e o resultado é decidido relendo
  o vencedor.
- **Referência e reversão:** a referência válida é da mesma carteira, então ler o seu
  estado e verificar reversões anteriores acontece sob o mesmo lock. O índice único
  parcial é a garantia final.
- **Lock esgotado:** 503 `WALLET_BUSY` com `Retry-After`, sem gravar nada; repetir com a
  mesma chave é seguro.

**`payloadHash`:** SHA-256 em hexadecimal do JSON canônico (chaves ordenadas
recursivamente, sem espaços, só strings e `null`) dos campos de negócio: `providerId`,
`externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`,
`money: { amount normalizado, currency }` e `referenceExternalTransactionId`. Ficam de
fora a `Idempotency-Key`, o `X-Correlation-Id` e metadados de transporte. `"10"` e
`"10.00"` geram o mesmo hash.

## Schema e garantias no banco

Migrations SQL escritas à mão, todas com `down`:

| Migration | Conteúdo |
| --- | --- |
| `Migration20261031000000_base` | fuso do banco em UTC |
| `Migration20261102000000_carteiras_e_transacoes` | carteiras e transações, constraints e trigger de imutabilidade |
| `Migration20261102010000_ledger` | ledger, aritmética, triggers |
| `Migration20261102020000_outbox` | outbox |

> As migrations do domínio foram **consolidadas na Etapa 8**: o schema mudou por inteiro
> para o contrato do desafio e nada tinha sido publicado. Um volume local criado antes
> precisa ser recriado (`docker compose down -v`).

| Regra | Como o banco garante |
| --- | --- |
| Uma carteira por jogador e moeda | `UNIQUE (player_id, currency)` |
| Saldo não negativo | `CHECK (balance >= 0)`; ledger com `balance_before >= 0` e `balance_after >= 0` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Um lançamento por transação | `UNIQUE (transaction_id)` no ledger |
| Sem lost update no ledger | `UNIQUE (wallet_id, wallet_version)`: dois lançamentos partindo do mesmo saldo colidem |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| Lançamento só de transação que move saldo | trigger de inserção exige transação `PROCESSED` e não LOSS |
| Moeda do lançamento = carteira = transação | FKs compostas `(wallet_id, currency) → wallets` e `(transaction_id, wallet_id, currency) → wager_transactions` |
| Referência do mesmo provedor, jogador, carteira, moeda e rodada | FK composta `(reference_transaction_id, provider_id, player_id, wallet_id, currency, round_id)` |
| Uma reversão por referência | índice único parcial em `reference_transaction_id WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Uma OPENING por carteira | índice único parcial em `wallet_id WHERE kind = 'OPENING'` |
| Forma por kind | `CHECK` combinando `kind`, `amount` e referência; provedor `internal` reservado à OPENING |
| Coerência de estado | `CHECK`s: `failure_code` ⇔ REJECTED/FAILED; `processed_at` ⇔ terminal; saldo observado presente fora de PENDING/FAILED; PENDING_REFERENCE só com referência; vínculo ⇔ PROCESSED com referência |
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Transação imutável | trigger bloqueia exclusão, mudança de campos de negócio, mudança após estado terminal e volta a PENDING |
| Outbox imutável | trigger permite mudar só o controle de publicação; `published_at` não volta; `CHECK` amarra `id`/`event_type` ao envelope |

- **Erros dos triggers:** SQLSTATE `P0001` com `hint` estável (`LEDGER_IMMUTABLE`,
  `TRANSACTION_IMMUTABLE`, `OUTBOX_IMMUTABLE`, `LEDGER_REQUIRES_PROCESSED_TRANSACTION`).
- **Reversibilidade:** os `down` que apagariam dados financeiros **recusam rodar se
  houver dados**.

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/health/live` | 200 enquanto o processo está de pé, sem consultar dependências |
| GET | `/health/ready` | `select 1` no PostgreSQL e `GetQueueUrl` da fila, timeout de 2 s; 503 com o detalhe |
| POST | `/wallets` | `{ playerId, initialBalance: { amount, currency } }` → `{ id, playerId, balance, version, ... }` |
| GET | `/wallets/:walletId` | carteira e saldo |
| POST | `/wagering/transactions` | `Idempotency-Key` obrigatório; corpo do desafio → `{ transactionId, status, balance, idempotentReplay, failureCode? }` |
| GET | `/wagering/transactions/:transactionId` | transação completa |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |

`X-Correlation-Id` (opcional) é gravado na transação e propagado aos eventos; sem ele, um
novo é gerado.

### Status HTTP

O mapeamento é o mesmo em todos os endpoints:

| Situação | Status | Reenviar? |
| --- | --- | --- |
| PROCESSED | 201 | não precisa; replay devolve o mesmo |
| PENDING_REFERENCE (aceita, processamento pendente) | 202 | não; será reprocessada |
| REJECTED (regra de negócio, gravada com `failureCode`) | 422 | não; ver [Códigos de falha](#códigos-de-falha) |
| Replay | o mesmo status da primeira resposta, `idempotentReplay: true` | — |
| Mesma chave, payload diferente | 409 `IDEMPOTENCY_KEY_CONFLICT` | não |
| Mesmo id externo, outra chave | 409 `EXTERNAL_TRANSACTION_CONFLICT` | não |
| Payload inválido | 400 (`INVALID_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `INVALID_TRANSACTION`, `INVALID_WALLET`) | corrigir |
| Carteira ou transação inexistente | 404 `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | — |
| Carteira duplicada | 409 `WALLET_ALREADY_EXISTS`, com `details.walletId` | não |
| Falha transitória (lock não obtido em 5 s) | 503 `WALLET_BUSY`, `Retry-After: 1` | sim, mesma chave |
| Erro inesperado | 500 `INTERNAL_ERROR`, nada gravado | sim, mesma chave |

- **Replay reproduz a resposta original:** status e corpo derivam só do estado gravado,
  incluindo o saldo observado naquele momento.
- **Formato dos erros:** `{ "error": { "code", "message", "details"? } }`.
- **Validação manual** (`src/api/requisicao.ts`): tipo de cada campo, `money` como objeto de
  strings e rejeição de campos desconhecidos. As regras de valor ficam no domínio.

## Eventos e outbox

- **Envelope:** classe abstrata `IntegrationEvent<T>` com uma subclasse por evento;
  `eventType` e `version` ficam no tipo. `toJSON()` produz
  `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt (ISO-8601), version, data }`.
  `data` carrega `MoneyProps`, nunca `Money`.
- **Eventos:**

  | Evento | Quando | `aggregateId` |
  | --- | --- | --- |
  | `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS e OPENING | transação |
  | `WagerTransactionRejected` | rejeição por regra de negócio | transação |
  | `WalletBalanceChanged` | só quando o saldo muda (com `balanceBefore`, `balanceAfter`, `walletVersion`) | carteira |
  | `WagerTransactionPendingReference` | referência ausente | transação |

- **`eventId` determinístico:** UUID derivado de `(transactionId, eventType)`. É a PK da
  outbox, então o mesmo fato nunca é gravado duas vezes, e o consumidor deduplica
  republicações pelo `eventId`.
- **`OutboxMessage`** (domínio): `enqueue(event)`, `isPending`, `isDue`,
  `markPublished`, `scheduleRetry` (backoff 2^n s, máximo 300 s, sem limite de tentativas:
  um evento confirmado não pode ser perdido).
- **Publicação** (`OutboxPublisher`), dentro de uma transação:
  1. seleciona até 10 mensagens vencidas com `FOR UPDATE SKIP LOCKED`
     (`LockMode.PESSIMISTIC_PARTIAL_WRITE`);
  2. envia com `SendMessageBatch` (atributos `eventId` e `eventType`);
  3. marca publicada ou agenda nova tentativa, gravando `last_error`; commit.
- **Várias instâncias:** cada uma roda o seu worker; o `SKIP LOCKED` divide as linhas.
  Se uma instância morre depois do commit e antes de publicar, outra publica (teste).
- **At-least-once:** queda entre o envio e o commit reenvia a mensagem; o `eventId` é o
  mesmo.

## Infraestrutura e operação

- **Docker Compose:** `postgres` 16; `localstack` 4.4 (só SQS, fila criada por script de
  init); `migrate`, que roda as migrations uma vez e termina; `app`, que só sobe depois.
- **Migrations nunca rodam na subida da aplicação:** com várias instâncias, todas
  tentariam migrar ao mesmo tempo.
- **LocalStack fixado em 4.4:** versões mais novas exigem token de conta.
- **Configuração** validada na subida (`src/configuracao.ts`); `AppModule.register(config)`
  permite aos testes montar várias instâncias.

## Testes

`bun test` roda 244 testes (unidade e integração); `bun run test:concurrency` roda o
arquivo de concorrência 20 vezes (320 execuções, cerca de 110 s).

| Suíte | O que cobre |
| --- | --- |
| `test/unit/domain` | `Money` (escala, entradas inválidas, negate, moedas), `Wallet`, `WalletLedgerEntry`, `WagerTransaction` (forma, hash, transições), regras de BET/WIN/LOSS/REFUND/ROLLBACK, eventos e `OutboxMessage` |
| `schema.test.ts` | cada constraint e trigger, com SQLSTATE e nome; ida e volta pelos mappers |
| `migrations.test.ts` | `up` e `down` completos; `down` recusado com dados |
| `wallets-api.test.ts`, `wagering-api.test.ts` | contrato, status HTTP, idempotência, regras e consultas; invariantes após cada teste |
| `outbox.test.ts` | atomicidade, nada publicado antes do commit, 4 publishers sem duplicata, falha com backoff, crash antes de publicar, imutabilidade, worker |
| `concurrency.test.ts` | **três instâncias** com pools separados |

**Cenários de concorrência** (invariantes conferidas no banco depois de cada um):

- cenário obrigatório: 100.00 e duas BET de 80.00 em instâncias diferentes (10 rodadas);
- a mesma BET 50 vezes por 3 instâncias: um débito, 49 replays, todos com o mesmo saldo;
- o mesmo REFUND 30 vezes: um crédito;
- REFUND e ROLLBACK da mesma BET em paralelo: uma reversão;
- hot wallet: 60 BET concorrentes, 14 processadas, saldo final exato;
- carteiras distintas com carga mista embaralhada (dependentes antes da referência,
  replays).

**Invariantes** (`test/support/invariants.ts`): saldo = ledger; ledger encadeado por
`wallet_version` (`balance_before` = `balance_after` anterior); `version` = 1 +
movimentos; lançamento correto por transação que move saldo; nenhum lançamento para
LOSS/REJECTED/PENDING_REFERENCE; eventos do estado gravados. Um teste confirma que a
verificação detecta uma divergência real.

**Teste de mutação:** sem o `FOR UPDATE`, 13 dos 16 testes de concorrência falham.

## Autenticação (desenho, não implementado)

O `AuthGuard` (`src/autenticacao/guarda-autenticacao.ts`) não restringe nada; está aplicado aos controllers
de carteira e de apostas como ponto de extensão. Health fica aberto.

Desenho previsto com um IdP externo (Keycloak ou Zitadel no Compose):

1. Cada provedor de jogos é um cliente do IdP e obtém um JWT via **OAuth 2.0 client
   credentials**.
2. O `AuthGuard` valida assinatura (JWKS em cache, com rotação), `iss`, `aud`,
   `exp`/`nbf` e escopos (`wagering:write`, `wallets:read`).
3. O `sub` identifica o provedor; o guard exige que ele seja igual ao `providerId` do
   corpo.
4. Autorização por carteira: o provedor só opera carteiras de jogadores vinculados a ele.
5. Mensagens da fila são canal interno confiável, mas o `providerId` delas passa pelas
   mesmas validações de domínio.

## Trade-offs

| Escolha | Ganho | Custo |
| --- | --- | --- |
| Lock pessimista por carteira | Simples de raciocinar; sem retry por conflito; sem deadlock | Throughput de **uma carteira** limitado pela serialização; carteiras diferentes não se afetam |
| Lock antes da busca de idempotência | Replays concorrentes enxergam o vencedor | O replay também espera o lock |
| Domínio separado dos records do ORM | Domínio puro, `Money` como objeto, `rehydrate` explícito | Mappers a manter em sincronia com o schema |
| Rejeições gravadas e repetíveis por replay | Resposta estável; rejeições auditáveis com evento | Uma BET rejeitada exige chave nova para nova tentativa |
| Erros transitórios não gravados | Repetir com a mesma chave é seguro | 503/500 não deixam rastro no banco (só no log) |
| `eventId` determinístico | Deduplicação na gravação e no consumidor | O id não é aleatório (é derivado de dados internos) |
| Outbox em vez de publicar direto | Nenhum evento sem commit; nenhum commit sem evento | Latência de publicação (poll de 500 ms) e at-least-once |
| Migrations SQL à mão, sem relações ORM | Controle total de constraints e triggers | Ordem de gravação imposta no código |

## Limitações e pendências

**Pendente nas próximas etapas:**

- **Etapa 9:** `GET /wallets/:id/ledger` com cursor e `POST /wallets/:id/reconciliation`.
- **Etapa 10:** consumidor SQS (`wager-transactions.fifo` e DLQ) com inbox, ack depois
  do commit, retry/DLQ e SIGTERM; worker que reprocessa `PENDING_REFERENCE` com backoff e
  limite (`REFERENCE_NOT_FOUND` ao esgotar). Hoje uma transação `PENDING_REFERENCE` só
  fica gravada; quando a referência chega, nada a reprocessa ainda.
- **Etapa 11:** logs JSON com `correlationId` e métricas; testes de crash antes do ack,
  reinício e DLQ.

**Limitações conhecidas:**

- **Depósitos:** só o saldo inicial da abertura.
- **Moedas:** todas com escala 2 (JPY, BHD não suportadas).
- **Usuário do banco:** os triggers não protegem contra o **dono** das tabelas nem contra
  `DROP`. Em produção, a aplicação usaria uma role sem ownership.
- **Migrate concorrente:** o Migrator do MikroORM 7.2 não usa advisory lock; o Compose
  roda um só.
- **Outbox:** sem limpeza de mensagens publicadas.
- **Carteira muito disputada:** 503 após 5 s de espera pelo lock.

## Quem decidiu o quê

- **Definido pelo responsável no SPEC:** stack, restrições, lock pessimista por
  carteira, idempotência por `Idempotency-Key` e `payloadHash`, outbox, estados e o escopo
  do MVP (Etapas 1 a 7).
- **Decidido pelo responsável:** saldo inicial no `POST /wallets` (Etapa 4); alinhar a
  entrega ao enunciado completo do desafio (Etapa 8 em diante).
- **Proposto pela IA e apresentado ao fim de cada etapa:** separação domínio/records,
  consolidação das migrations, uma reversão por referência de qualquer tipo, rejeições de
  moeda e jogador gravadas, `wallet_version` no ledger, `eventId` determinístico,
  taxonomia de `failureCode` e o mapeamento de status HTTP.
