# Arquitetura

Decisões, trade-offs e limitações do MVP do Distributed Wagering Processor. O escopo e
as restrições estão no [SPEC.md](SPEC.md); setup e comandos, no [README.md](README.md).

## Sumário

1. [Visão geral](#visão-geral)
2. [Conformidade com as restrições invioláveis](#conformidade-com-as-restrições-invioláveis)
3. [Modelo de domínio](#modelo-de-domínio)
4. [Concorrência e idempotência](#concorrência-e-idempotência)
5. [Schema e garantias no banco](#schema-e-garantias-no-banco)
6. [API](#api)
7. [Outbox e publicação no SQS](#outbox-e-publicação-no-sqs)
8. [Infraestrutura e operação](#infraestrutura-e-operação)
9. [Testes](#testes)
10. [Autenticação (desenho, não implementado)](#autenticação-desenho-não-implementado)
11. [Trade-offs](#trade-offs)
12. [Limitações e fora do escopo](#limitações-e-fora-do-escopo)
13. [Quem decidiu o quê](#quem-decidiu-o-quê)

## Visão geral

```
provedor ──HTTP──▶ NestJS (N instâncias)
                     │  uma transação de banco por requisição:
                     │  lock da carteira → idempotência → regra → transação + saldo + ledger + evento
                     ▼
                  PostgreSQL ◀── OutboxPublisher (em cada instância, FOR UPDATE SKIP LOCKED)
                                        │
                                        ▼
                                SQS (fila padrão, LocalStack)
```

- **A correção depende do PostgreSQL**, não do processo nem da fila: o lock, a
  unicidade, a não negatividade e a imutabilidade estão no banco.
- **Instâncias sem estado:** qualquer número delas pode rodar ao mesmo tempo.
- **Nenhum evento sai antes do commit:** ele é gravado na mesma transação e só depois
  publicado.

| Pasta | Conteúdo |
| --- | --- |
| `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`; sem dependência de framework |
| `src/persistence` | mapeamento MikroORM (`EntitySchema`) e tradução de erros do banco |
| `src/migrations` | migrations SQL versionadas e reversíveis |
| `src/wallets`, `src/wagering` | controllers e serviços da API |
| `src/outbox` | evento de outbox, publisher e worker |
| `src/api`, `src/auth`, `src/health` | erros e validação, guard de autenticação, health checks |

## Conformidade com as restrições invioláveis

| # | Restrição | Como é atendida | Evidência |
| --- | --- | --- | --- |
| 1 | Nada de `number`/`float`/`double` para dinheiro | `Money` guarda centavos em `bigint`, com entrada e saída em string de escala 2. Colunas `numeric(18,2)` lidas e gravadas como string. A API rejeita `amount` numérico. | `src/domain/money.ts`, `entity-schemas.ts`. Testes: `money.test.ts` ("rejeita number"), `wagering-api.test.ts` ("amount como number"). Auditoria por busca: `number` só aparece em porta, `version`, status HTTP e timeout. |
| 2 | Nenhuma idempotência em memória | A chave e o `payloadHash` ficam em `wager_transactions`, com `UNIQUE (idempotency_key)`. A busca é feita no banco, com o lock da carteira. Não há cache. | `wagering.service.ts`. Testes de replay e conflito entre **duas instâncias** em `concurrency.test.ts`. |
| 3 | Não confiar só em SQS FIFO | A fila é padrão (não FIFO). A consistência vem do banco. O evento leva `eventId` (deduplicação) e `walletVersion` (ordenação). | `docker/localstack/init`, `outbox-event.ts` |
| 4 | Não publicar antes do commit | Outbox gravado na mesma transação. O publisher só lê linhas commitadas. | Teste "não publica evento de transação ainda não commitada" (`outbox.test.ts`) |
| 5 | Nunca sobrescrever ou excluir o ledger | Trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE`. O `down` da migration recusa rodar com lançamentos. | `Migration20261101000000_wagering_schema.ts`. Testes em `schema.test.ts` e `migrations.test.ts`. |
| 6 | Sem lock global | `SELECT ... FOR UPDATE` só na linha da carteira. Nenhum advisory lock nem `LOCK TABLE` (conferido por busca). | `wagering.service.ts` |
| 7 | Sem ler → calcular → gravar sem controle | Leitura do saldo com `FOR UPDATE` na mesma transação da escrita, mais `CHECK (balance >= 0)` como rede. | Sem o lock, 12 dos 15 testes de concorrência falham (ver [Testes](#testes)) |
| 8 | Correto com várias instâncias | Nenhum estado no processo. Os testes de concorrência sobem duas aplicações com pools separados. O outbox usa `SKIP LOCKED`. | `concurrency.test.ts`. Teste com 4 publishers em `outbox.test.ts`. |
| 9 | Unicidade, imutabilidade e não negatividade no schema | `UNIQUE`, `CHECK`, FKs compostas, índice único parcial e triggers. | Tabela em [Schema](#schema-e-garantias-no-banco); um teste por constraint em `schema.test.ts` |
| 10 | Testes de integração com PostgreSQL real | Os testes usam o PostgreSQL 16 do Compose (banco `wagering_test`) e o LocalStack real. Sem mock de banco. | `test/integration/*` |

## Modelo de domínio

Classes em `src/domain`, com construtor privado e factories estáticas. O MikroORM
reconstrói entidades lidas do banco com `Object.create(prototype)`, sem chamar o
construtor.

### Money

- Guarda centavos em `bigint`. Entrada e saída são strings decimais com escala 2
  (`"10"` e `"10.5"` viram `"10.00"` e `"10.50"`).
- Aceita até 16 dígitos inteiros e 2 decimais (o intervalo de `numeric(18,2)`). Rejeita
  sinal, expoente, espaços, zeros à esquerda e `number` em tempo de execução.
- Não negativo: subtração com resultado negativo e estouro lançam `AMOUNT_OUT_OF_RANGE`.
- Operações entre moedas diferentes lançam `CURRENCY_MISMATCH`.
- Imutável: `Object.freeze` e operações que devolvem nova instância.

### Wallet e WalletLedgerEntry

- O saldo só muda por `debit` e `credit`. Cada um valida moeda e saldo, incrementa
  `version` e **devolve o lançamento do ledger**. Toda mudança de saldo tem exatamente
  um lançamento, por construção.
- O lançamento é imutável e guarda `amount` e `balanceAfter`.
- O lançamento de abertura (`kind = 'OPENING'`) registra o `initialBalance`: é CREDIT,
  não tem transação de aposta e existe no máximo um por carteira. Assim, saldo = soma do
  ledger vale desde a criação.

### WagerTransaction

| Tipo | Valor | `referenceKey` | Efeito no saldo |
| --- | --- | --- | --- |
| BET | > 0 | proibida | débito |
| WIN | > 0 | obrigatória: chave de idempotência da BET | crédito |
| LOSS | `0.00` | obrigatória: chave de idempotência da BET | nenhum (só liquida a aposta) |

- **Referência:** WIN e LOSS apontam para a BET pela chave de idempotência dela, porque
  é o identificador que o provedor conhece.
- **Estados:**
  - `PENDING`: só existe em memória; nunca é commitado pela API.
  - `PENDING_REFERENCE`: WIN/LOSS cuja BET ainda não chegou.
  - `PROCESSED`, `REJECTED` e `FAILED`: terminais, não mudam mais.
  - Uma WIN/LOSS só vira PROCESSED depois de vinculada à BET.
- **`failureCode`:** valores estáveis, em `FAILURE_CODES`:
  - `INSUFFICIENT_FUNDS`
  - `CURRENCY_MISMATCH`
  - `REFERENCE_NOT_A_BET`
  - `REFERENCE_NOT_PROCESSED`
  - `REFERENCE_WALLET_MISMATCH`
  - `BET_ALREADY_SETTLED`
  - `INTERNAL_ERROR`
- **`payloadHash`:** SHA-256 do JSON canônico (chaves ordenadas) de `walletId`, `type`,
  `amount` normalizado, `currency` e `referenceKey`. A chave de idempotência fica de fora,
  porque é a identidade da requisição, não o conteúdo.

## Concorrência e idempotência

`POST /wagering/transactions` roda em uma única transação de banco (`READ COMMITTED`):

1. `SET LOCAL lock_timeout = '5s'`.
2. `SELECT ... FOR UPDATE` na carteira. Requisições para a mesma carteira são
   serializadas; carteiras diferentes não disputam lock.
3. **Com o lock na mão**, busca a `Idempotency-Key`. Em `READ COMMITTED` cada comando
   enxerga o que já foi commitado, então uma requisição concorrente que pegou o lock antes
   já está visível. Mesmo hash é replay; hash diferente é 409.
4. Aplica a regra:
   - BET debita ou é rejeitada por saldo;
   - WIN/LOSS procura a BET: grava `PENDING_REFERENCE`, `REJECTED`, ou liquida.
5. Grava transação, saldo (`version` + 1), lançamento e evento de outbox. Depois, commit.

**Casos de borda:**

- **Mesma chave para carteiras diferentes ao mesmo tempo:** o lock por carteira não
  serializa esse caso. O `UNIQUE (idempotency_key)` barra o segundo insert, e o
  resultado é decidido relendo o registro vencedor.
- **Liquidação dupla da mesma BET:** a BET é da mesma carteira, então a verificação roda
  sob o mesmo lock. O índice único parcial é a garantia final.
- **Sem deadlock:** cada transação trava uma única linha de carteira.
- **Lock esgotado:** responde 503 `WALLET_BUSY` sem gravar nada; repetir é seguro.

## Schema e garantias no banco

Quatro migrations SQL escritas à mão, todas com `down`:

| Migration | Conteúdo |
| --- | --- |
| `Migration20261031000000_baseline` | fuso do banco em UTC |
| `Migration20261101000000_wagering_schema` | carteiras, transações e ledger, com constraints e triggers |
| `Migration20261101010000_opening_balance` | lançamento de abertura |
| `Migration20261101020000_outbox` | outbox |

| Regra | Como o banco garante |
| --- | --- |
| Uma carteira por jogador e moeda | `UNIQUE (player_id, currency)` |
| Saldo não negativo | `CHECK (balance >= 0)`; no ledger, `amount > 0` e `balance_after >= 0` |
| Idempotência | `UNIQUE (idempotency_key)` |
| Um lançamento por transação | `UNIQUE (transaction_id)` no ledger |
| No máximo uma abertura por carteira | índice único parcial `WHERE kind = 'OPENING'` |
| Uma liquidação por BET | índice único parcial em `reference_transaction_id WHERE status = 'PROCESSED' AND type IN ('WIN','LOSS')` |
| Moeda de transação e lançamento = moeda da carteira | FK composta `(wallet_id, currency) → wallets (id, currency)` |
| Lançamento e transação da mesma carteira | FK composta `(transaction_id, wallet_id) → wager_transactions (id, wallet_id)` |
| BET liquidada da mesma carteira | FK composta `(reference_transaction_id, wallet_id) → wager_transactions (id, wallet_id)` |
| Forma por tipo | `CHECK` combinando `type`, `amount` e `reference_key` |
| Coerência de estado | `CHECK`: `failure_code` só em REJECTED/FAILED; `processed_at` só em terminais; WIN/LOSS só PROCESSED com referência |
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Transação imutável | trigger bloqueia exclusão, mudança de campos de negócio e mudança após estado terminal |
| Outbox imutável | trigger permite mudar só as colunas de controle de publicação; `published_at` não volta |

- **Erros dos triggers:** usam SQLSTATE `P0001` com `hint` estável
  (`LEDGER_IMMUTABLE`, `TRANSACTION_IMMUTABLE`, `OUTBOX_IMMUTABLE`).
- **Reversibilidade:** os `down` que apagariam dados financeiros (schema, abertura,
  outbox) **recusam rodar se houver dados**. Um down acidental falha em vez de destruir
  histórico.
- **Mapeamento ORM:** `EntitySchema` sem decorators, com `type` e `columnType`
  explícitos em toda coluna. O MikroORM 7 não lê `design:type`, e as entidades não
  dependem disso.
  - O `EntitySchema` tipado não enxerga campos privados. Por isso o estado persistido
    fica em campos privados com tipos primitivos (por exemplo `balanceAmount: string`),
    e `Money` e o estado saem por métodos (`wallet.balance()`, `tx.status()`).
  - Não há relações ORM, só colunas uuid. O código grava na ordem das FKs: carteira →
    transação → lançamento e evento.

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/health/live` | 200 enquanto o processo está de pé, sem consultar dependências |
| GET | `/health/ready` | `select 1` no PostgreSQL e `GetQueueUrl` da fila, com timeout de 2 s; 503 com o detalhe |
| POST | `/wallets` | `playerId`, `currency`, `initialBalance` opcional |
| GET | `/wallets/:id` | carteira e saldo |
| POST | `/wagering/transactions` | BET, WIN, LOSS; header `Idempotency-Key` obrigatório |

### Status HTTP

| Situação | Status |
| --- | --- |
| PROCESSED | 201 |
| PENDING_REFERENCE | 202 |
| REJECTED (regra de negócio, gravada com `failureCode`) | 422 |
| Replay | o mesmo da primeira resposta, com header `Idempotent-Replayed: true` |
| Mesma chave, payload diferente | 409 `IDEMPOTENCY_KEY_CONFLICT` |
| Entrada inválida | 400 (`INVALID_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_AMOUNT`, `INVALID_TRANSACTION`, ...) |
| Carteira inexistente | 404 `WALLET_NOT_FOUND` |
| Moeda diferente da carteira | 422 `CURRENCY_MISMATCH` (não gravada: a FK composta não permitiria) |
| Carteira duplicada | 409 `WALLET_ALREADY_EXISTS`, com `details.walletId` |
| Lock não obtido em 5 s | 503 `WALLET_BUSY` |

- **Replay reproduz a resposta original**, porque o status deriva só do estado gravado.
- **Formato dos erros:** `{ "error": { "code", "message", "details"? } }`.
- **Validação manual** (`src/api/request.ts`): checa o tipo de cada campo e rejeita
  campos desconhecidos. As regras de valor ficam no domínio.
- **FAILED não é produzido pela API.** Uma falha inesperada desfaz a transação (500) e
  não consome a chave. Gravar FAILED tornaria definitiva uma falha transitória. O estado
  fica reservado para processamento assíncrono, fora do MVP.

## Outbox e publicação no SQS

- **Gravação:** cada transação gravada gera um evento no mesmo commit:
  - `wager.transaction.processed`
  - `wager.transaction.rejected`
  - `wager.transaction.pending_reference`

  `UNIQUE (aggregate_id, event_type)` impede duplicata. O payload leva valores em
  string, o saldo depois da operação e `walletVersion`.
- **Publicação** (`OutboxPublisher`), dentro de uma transação:
  1. seleciona até 10 eventos pendentes com `FOR UPDATE SKIP LOCKED`;
  2. envia com `SendMessageBatch`, com os atributos `eventId` e `eventType`;
  3. marca `published_at`; se falhar, incrementa `attempts`, grava `last_error` e agenda
     nova tentativa com backoff exponencial (2^n s, máximo 300 s);
  4. faz commit.
- **Várias instâncias:** cada uma roda o seu `OutboxPublisherWorker`, e o `SKIP LOCKED`
  divide as linhas.
- **At-least-once:** se o processo cair entre o envio e o commit que marca
  `published_at`, o evento é reenviado. O consumidor deduplica por `eventId`.
- **Configuração:** `OUTBOX_PUBLISHER_ENABLED` (padrão `true`) e
  `OUTBOX_POLL_INTERVAL_MS` (padrão 500).

## Infraestrutura e operação

- **Docker Compose:**
  - `postgres` 16;
  - `localstack` 4.4, só SQS, com a fila criada por script de init;
  - `migrate`, que roda as migrations uma vez e termina;
  - `app`, que só sobe depois de `migrate` terminar com sucesso.
- **Migrations nunca rodam na subida da aplicação:** com várias instâncias, todas
  tentariam migrar ao mesmo tempo.
- **LocalStack fixado em 4.4:** essa versão sobe sem token de conta; imagens mais novas
  exigem token.
- **Configuração** validada na subida (`src/config.ts`). O `AppModule.register(config)`
  recebe a configuração por parâmetro, o que permite aos testes montar instâncias com
  configurações diferentes.

## Testes

Para rodar: `bun test`. São 158 testes no total.

| Suíte | O que cobre |
| --- | --- |
| `test/unit` | `Money`, `Wallet`, `WagerTransaction`, configuração |
| `schema.test.ts` | cada constraint e trigger, com SQLSTATE e nome da constraint, e ida e volta pelo ORM |
| `migrations.test.ts` | `up` e `down` completos; `down` recusado com dados |
| `wallets-api.test.ts`, `wagering-api.test.ts` | API, status HTTP, idempotência, regras de BET/WIN/LOSS |
| `outbox.test.ts` | atomicidade, nada publicado antes do commit, 4 publishers sem duplicata, falha com backoff, imutabilidade, worker |
| `concurrency.test.ts` | duas instâncias da aplicação com pools separados (ver abaixo) |

**Cenários de concorrência**, com as invariantes conferidas no banco ao fim de cada um
(`test/support/invariants.ts`):

- saldo 100 e duas BET de 80 em paralelo (10 rodadas): uma PROCESSED, uma REJECTED,
  saldo 20.00, um débito;
- a mesma BET 50 vezes: um débito, uma linha, 49 replays;
- a mesma WIN 50 vezes: um crédito;
- WIN e LOSS da mesma BET em paralelo: só uma liquida;
- carga mista embaralhada, com replays pela outra instância.

**Invariantes verificadas:**

- saldo = créditos − débitos do ledger;
- `version` = 1 + número de lançamentos;
- BET/WIN processada tem exatamente um lançamento do valor e na direção certa;
- transações sem efeito no saldo não têm lançamento;
- toda transação tem exatamente um evento no outbox.

Um teste confirma que a verificação detecta uma divergência real.

**Teste de mutação:** sem o `FOR UPDATE`, 12 dos 15 testes de concorrência falham (lost
update). O cenário das 50 BETs iguais continua passando, porque o `UNIQUE` da chave
segura sozinho: as camadas são independentes.

**Execução repetida:** `bun run test:concurrency` roda o arquivo 20 vezes (300 testes,
cerca de 70 s).

## Autenticação (desenho, não implementado)

Hoje o `AuthGuard` (`src/auth/auth.guard.ts`) não restringe nada. Ele está aplicado aos
controllers de carteira e de apostas como ponto de extensão.

Desenho previsto com um IdP externo (por exemplo Keycloak, Auth0 ou Cognito):

1. Cada provedor de jogos é um cliente do IdP e obtém um access token JWT via
   **OAuth 2.0 client credentials**.
2. O `AuthGuard` valida assinatura (chaves do JWKS do IdP, em cache e com rotação),
   `iss`, `aud`, `exp`/`nbf` e escopos (`wagering:write`, `wallets:read`).
3. O `sub` do token identifica o provedor e entra no contexto da requisição.
4. A `Idempotency-Key` passa a ser única **por provedor**: `UNIQUE (provider_id,
   idempotency_key)`. Assim, dois provedores não colidem nem enxergam as transações um do
   outro.
5. Autorização por carteira: o provedor só opera carteiras de jogadores vinculados a ele.
6. Para provedores que não suportam OAuth, a alternativa é mTLS ou assinatura HMAC do
   corpo com timestamp (proteção contra replay), validada no mesmo guard.

## Trade-offs

| Escolha | Ganho | Custo |
| --- | --- | --- |
| Lock pessimista por carteira | Simples de raciocinar; sem retry por conflito; sem deadlock (uma linha por transação) | Throughput de **uma carteira** limitado pela serialização. Carteiras diferentes não se afetam. |
| Lock antes da busca de idempotência | Replays concorrentes da mesma chave e carteira são serializados e enxergam o vencedor | O replay também espera o lock da carteira |
| Rejeições gravadas (REJECTED) e repetíveis por replay | Resposta estável: o replay de uma rejeição continua rejeitado, mesmo que o saldo mude | Uma BET rejeitada não pode ser "tentada de novo" com a mesma chave; o provedor precisa de chave nova |
| Erros transitórios não gravados | Repetir com a mesma chave é seguro e pode dar certo | O 503/500 não deixa rastro no banco (só no log) |
| Outbox em vez de publicar direto | Nenhum evento sem commit; nenhum commit sem evento | Latência de publicação (poll de 500 ms) e entrega at-least-once |
| Linhas do outbox travadas durante o envio | Nenhuma linha é enviada por dois publishers ao mesmo tempo | Transação aberta durante a chamada ao SQS (lote pequeno, `SKIP LOCKED` evita espera) |
| Migrations SQL à mão, sem relações ORM | Controle total de constraints e triggers; mapeamento simples | O código precisa respeitar a ordem das FKs ao gravar |
| Validação manual da entrada | Sem dependência extra; rejeição de campos desconhecidos | Mais código que `class-validator` se a API crescer |

## Limitações e fora do escopo

**Fora do escopo do SPEC, não implementado:**

- **Autenticação:** guard sem efeito; desenho [acima](#autenticação-desenho-não-implementado).
- **Reprocessamento de PENDING_REFERENCE com backoff:** a WIN/LOSS que chega antes da BET
  fica em `PENDING_REFERENCE`. Quando a BET chega, nada a reprocessa, e o replay da mesma
  chave devolve o estado gravado.
- **Métricas completas e teste de carga.** Também não há alerta de eventos do outbox com
  muitas tentativas.
- **REFUND e ROLLBACK, consumidor SQS com inbox, `GET` do ledger com cursor e
  reconciliação** (opcionais do SPEC). REFUND/ROLLBACK chegam como 400
  `INVALID_TRANSACTION`.

**Limitações conhecidas:**

- **Depósitos:** só o saldo inicial da abertura. Não há depósito nem saque depois.
- **Moedas:** todas usam escala 2. Moedas com outra escala (JPY, BHD) não são suportadas.
- **Usuário do banco:** os triggers de imutabilidade não protegem contra o **dono** das
  tabelas, que pode desabilitá-los, nem contra `DROP`. Em produção, a aplicação usaria
  uma role sem ownership, com só `INSERT`/`SELECT` no ledger e no outbox. No MVP,
  aplicação e migrations usam o mesmo usuário.
- **Migrate concorrente:** o Migrator do MikroORM 7.2 não usa advisory lock (conferido no
  código do pacote), então duas execuções simultâneas do `migrate` não são seguras. O
  Compose roda uma só; em produção seria um job único no deploy.
- **Outbox:** não há dead-letter para eventos que falham sempre (são tentados a cada
  300 s), nem limpeza de eventos publicados.
- **Ordem dos eventos:** a fila padrão não garante ordem; o consumidor deve usar
  `walletVersion`.
- **Carteira muito disputada:** recebe 503 após 5 s de espera pelo lock. O provedor deve
  repetir com a mesma chave.

## Quem decidiu o quê

- **Definido pelo responsável no SPEC:** stack, restrições, lock pessimista por
  carteira com `CHECK (balance >= 0)` e `version`, idempotência por `Idempotency-Key` e
  `payloadHash`, outbox, estados e escopo.
- **Decidido pelo responsável durante a implementação:** saldo inicial como lançamento
  de abertura no `POST /wallets`, entre as opções apresentadas.
- **Proposto pela IA e apresentado ao responsável ao fim de cada etapa:** repositório
  próprio, migration de base mínima, banco de testes no Compose, forma de BET/WIN/LOSS e
  referência pela chave da BET. Também os status HTTP, FAILED reservado para
  processamento assíncrono, fila padrão e erros transitórios não gravados. As escolhas da
  Etapa 1 foram delegadas pelo responsável ("faça o que achar melhor"). As demais foram
  destacadas no resumo de cada etapa antes de seguir.
