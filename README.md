# Distributed Wagering Processor

Serviço financeiro que recebe transações de apostas de provedores de jogos (BET, WIN,
LOSS, REFUND e ROLLBACK), por HTTP ou por fila SQS, atualiza o saldo das carteiras e mantém
um ledger imutável.

Ele continua correto quando as mensagens chegam **repetidas**, **fora de ordem** ou
**ao mesmo tempo**, e com **várias instâncias** da aplicação rodando juntas.

Desenvolvido para o desafio técnico da Jungle Gaming.

## Destaques

- **Dinheiro sem `number`:** valores em centavos (`bigint`) no código e `numeric(18,2)`
  no banco, sempre trafegando como string (`"25.00"`).
- **Sem saldo negativo nem débito duplicado:** lock por carteira (`SELECT ... FOR UPDATE`)
  e `CHECK (balance >= 0)` no banco.
- **Idempotência persistente:** `Idempotency-Key` e `payloadHash` gravados no banco; a
  mesma requisição devolve a mesma resposta, e o mesmo id com outro conteúdo é conflito.
- **Ledger auditável:** todo movimento gera um lançamento com saldo antes e depois; o
  banco impede alterar ou apagar lançamentos.
- **Eventos só depois do commit:** padrão outbox transacional publicando no SQS.
- **Fila com inbox e DLQ:** consumidor da fila FIFO com deduplicação persistente, ack só
  depois do commit, retry com backoff e dead-letter.
- **Fora de ordem:** um REFUND que chega antes da aposta espera e é aplicado quando ela
  chega.
- **Observável:** logs JSON com `correlationId` e métricas Prometheus em `/metrics`.
- **Testado de verdade:** PostgreSQL e LocalStack reais, com três instâncias disputando a
  mesma carteira, worker morto antes do ack e reinício no meio do processamento.

## Stack

Bun 1.4 · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 16 ·
SQS via LocalStack 4.4 · Docker Compose

## Como rodar

Pré-requisito: Docker.

```bash
git clone https://github.com/LeonardoHilario1/Desafio_Jungle.git
cd Desafio_Jungle
docker compose up -d --build
curl localhost:3000/health/ready
```

A subida segue esta ordem:

1. `postgres` e `localstack` ficam saudáveis (o LocalStack cria as filas
   `wagering-events`, `wager-transactions.fifo` e `wager-transactions-dlq.fifo`).
2. `migrate` aplica as migrations e termina.
3. `app` sobe na porta 3000.

Para parar: `docker compose down` (ou `docker compose down -v` para apagar também os
dados).

## Exemplos de uso

Criar uma carteira com saldo inicial:

```bash
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

Fazer uma aposta (troque `<walletId>` pelo `id` devolvido acima):

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Resposta:

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Enviar o mesmo comando de novo devolve a mesma resposta com `"idempotentReplay": true`,
sem debitar outra vez.

Reembolsar a aposta (a referência é o id da aposta no provedor):

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:refund-1' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "refund-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "REFUND",
    "money": { "amount": "25.00", "currency": "BRL" },
    "referenceExternalTransactionId": "transaction-123"
  }'
```

Enviar uma transação pela fila (o consumidor da aplicação processa sozinho):

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{
    "messageId": "msg-123",
    "type": "WagerTransactionRequested",
    "occurredAt": "2026-07-29T15:00:00.000Z",
    "data": {
      "providerId": "provider-a",
      "externalTransactionId": "transaction-456",
      "idempotencyKey": "provider-a:transaction-456",
      "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      "walletId": "<walletId>",
      "roundId": "round-987",
      "gameId": "fortune-chimp",
      "kind": "BET",
      "money": { "amount": "10.00", "currency": "BRL" }
    }
  }'
```

Ver os eventos publicados no SQS:

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events \
  --message-attribute-names All --max-number-of-messages 10
```

## Endpoints

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/health/live` | processo vivo |
| GET | `/health/ready` | PostgreSQL e SQS alcançáveis (503 se não) |
| GET | `/metrics` | métricas no formato Prometheus |
| POST | `/wallets` | cria carteira com `playerId` e `initialBalance` |
| GET | `/wallets/:walletId` | carteira e saldo |
| GET | `/wallets/:walletId/ledger?cursor=...&limit=50` | lançamentos da carteira, paginados por cursor |
| POST | `/wallets/:walletId/reconciliation` | confere o saldo gravado contra o ledger |
| POST | `/wagering/transactions` | envia BET, WIN, LOSS, REFUND ou ROLLBACK (`Idempotency-Key` obrigatório) |
| GET | `/wagering/transactions/:transactionId` | transação pelo id interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |

**Status HTTP:**

| Status | Quando |
| --- | --- |
| 201 | transação processada |
| 202 | aceita, aguardando a transação referenciada |
| 400 | payload inválido |
| 404 | carteira ou transação não encontrada |
| 409 | mesma `Idempotency-Key` com outro conteúdo, ou carteira duplicada |
| 422 | recusada por regra de negócio (o corpo traz o `failureCode`) |
| 503 | carteira ocupada; pode repetir com a mesma chave |

## Regras de negócio

| Tipo | Efeito no saldo | Regra principal |
| --- | --- | --- |
| BET | débito | recusada se o saldo não cobrir (`INSUFFICIENT_FUNDS`) |
| WIN | crédito | pode referenciar a BET da mesma rodada |
| LOSS | nenhum | registra o resultado sem mexer no saldo |
| REFUND | crédito | devolve uma BET processada, uma única vez |
| ROLLBACK | inverso da referência | desfaz uma BET, WIN ou REFUND processada, uma única vez |

- **Referência que ainda não chegou:** a transação fica `PENDING_REFERENCE`, sem mexer no
  saldo.
- **Reversão que deixaria o saldo negativo:** é recusada com
  `REVERSAL_INSUFFICIENT_FUNDS`, um código diferente do de aposta sem saldo.

Todos os códigos de falha estão no
[ARCHITECTURE.md](ARCHITECTURE.md#códigos-de-falha).

## Arquitetura

```
provedor ──HTTP──▶ NestJS (N instâncias)
                     │ uma transação SQL por operação:
                     │ lock da carteira → idempotência → regras → saldo + ledger + outbox
                     ▼
                  PostgreSQL ◀── publisher da outbox (em cada instância)
                                        │
                                        ▼
                                   SQS (LocalStack)
```

| Pasta | Conteúdo |
| --- | --- |
| `src/dominio` | regras de negócio puras: `Money`, `Wallet`, `WagerTransaction`, ledger, eventos |
| `src/aplicacao` | casos de uso (abrir carteira, processar transação, consultas) |
| `src/persistencia` | MikroORM, conversão banco ↔ domínio |
| `src/migracoes` | migrations SQL com as constraints e triggers |
| `src/carteiras`, `src/apostas` | controllers HTTP |
| `src/outbox` | publicação dos eventos no SQS |
| `src/fila` | consumidor da fila de entrada |
| `src/pendencias` | reprocessamento das transações que esperam a referência |
| `src/observabilidade` | logs JSON, métricas e correlationId |

As decisões, os trade-offs e as limitações estão explicados no
[ARCHITECTURE.md](ARCHITECTURE.md).

## Testes

Os testes de integração usam o PostgreSQL e o LocalStack reais do Compose, num banco
separado (`wagering_test`), sem mock do banco.

```bash
bun install
docker compose up -d postgres localstack
bun test                     # 287 testes
bun run test:concurrency     # testes de concorrência repetidos 20 vezes
```

O que é testado:

- **Unidade:** `Money`, carteira, ledger e as regras de cada tipo de transação.
- **Banco:** cada constraint e trigger do schema; migrations indo e voltando.
- **API:** contrato, status HTTP, idempotência, REFUND e ROLLBACK.
- **Fila:** inbox e reentrega, worker morto depois do commit e antes do ack, DLQ, retry
  com backoff e três consumidores ao mesmo tempo.
- **Fora de ordem:** pendências liberadas quando a referência chega, worker com limite de
  tentativas.
- **Reinício:** uma instância cai no meio do processamento da fila e outra termina, com o
  estado final conferido.
- **Concorrência:** três instâncias da aplicação ao mesmo tempo, incluindo o cenário do
  desafio (saldo 100.00 e duas apostas de 80.00 simultâneas: uma passa, a outra é
  recusada, saldo final 20.00).

Ao fim de cada cenário, os testes conferem no banco que o saldo de cada carteira é igual à
soma do ledger.

## Desenvolvimento local

Pré-requisitos: Bun 1.4+ e Docker.

```bash
bun install
cp .env.example .env          # o Bun carrega o .env automaticamente
docker compose up -d postgres localstack
bun run migration:up
bun run start
```

| Comando | O que faz |
| --- | --- |
| `bun run start` | sobe a aplicação |
| `bun run typecheck` | checagem de tipos (TypeScript strict) |
| `bun test` | todos os testes |
| `bun run test:unit` | só os unitários (não precisam de Docker) |
| `bun run test:integration` | só os de integração |
| `bun run test:concurrency` | concorrência, 20 vezes |
| `bun run migration:up` | aplica as migrations |
| `bun run migration:down` | reverte a última migration (recusa se houver dados financeiros) |

**Variáveis de ambiente:**

| Variável | Obrigatória | Padrão | Descrição |
| --- | --- | --- | --- |
| `PORT` | sim | | porta HTTP |
| `LOG_LEVEL` | não | `info` | `error`, `warn`, `info` ou `debug` |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | sim | | PostgreSQL |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | sim | | credenciais SQS (`test`/`test` no LocalStack) |
| `SQS_ENDPOINT` | sim | | endpoint do SQS |
| `SQS_OUTBOX_QUEUE_NAME` | sim | | fila dos eventos |
| `OUTBOX_PUBLISHER_ENABLED` | não | `true` | liga o publisher da outbox nesta instância |
| `OUTBOX_POLL_INTERVAL_MS` | não | `500` | intervalo entre buscas do publisher |
| `DB_LOCK_TIMEOUT_MS` | não | `5000` | espera máxima pelo lock da carteira |
| `SQS_INPUT_QUEUE_NAME`, `SQS_DLQ_NAME` | não | `wager-transactions.fifo`, `wager-transactions-dlq.fifo` | fila de entrada e DLQ |
| `CONSUMER_ENABLED` | não | `true` | liga o consumidor da fila nesta instância |
| `CONSUMER_MAX_ATTEMPTS` | não | `5` | tentativas com falha transitória antes da DLQ |
| `CONSUMER_RETRY_BASE_SECONDS` | não | `2` | base do backoff entre tentativas |
| `CONSUMER_WAIT_TIME_SECONDS` | não | `10` | long polling da fila |
| `PENDING_REFERENCE_WORKER_ENABLED` | não | `true` | liga o worker de pendências nesta instância |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | não | `10` | tentativas antes de `REFERENCE_NOT_FOUND` |

Se faltar uma variável obrigatória, a aplicação não sobe.

**Banco de testes:** o `wagering_test` é criado na **primeira** subida do volume do
Postgres. Se o volume já existia, recrie com `docker compose down -v`.

## Status do projeto

**Pronto:**

- carteiras, apostas e reversões;
- idempotência;
- ledger;
- outbox;
- consultas de transação;
- ledger paginado por cursor e reconciliação de saldo;
- consumidor SQS com inbox, retry, DLQ e shutdown gracioso;
- reprocessamento das transações que chegam antes da referência;
- logs estruturados e métricas;
- testes com várias instâncias.

**Próximos passos:**

- teste de carga (`bun run test:load`);
- OpenTelemetry e dashboard.

Autenticação ficou fora do escopo. O desenho previsto, com um Identity Provider externo,
está no [ARCHITECTURE.md](ARCHITECTURE.md#autenticação-desenho-não-implementado).

## Uso de IA

O projeto foi construído com apoio do **Claude Code** (Anthropic), em etapas. A cada etapa
a IA implementava, rodava os testes e explicava o que tinha feito. Eu revisava a etapa e
só então autorizava a seguinte.

**Decidido por mim:**

- **No [SPEC.md](SPEC.md):** stack, restrições, estratégia de lock por carteira,
  idempotência por `Idempotency-Key`, outbox e escopo inicial.
- **Saldo inicial:** como lançamento de abertura no ledger, escolhido entre as opções que
  a IA apresentou.
- **Alinhamento ao enunciado:** levar a entrega até o enunciado completo do desafio,
  depois do MVP.
- **Ajustes de forma:** nomes de pastas e arquivos em português e comentários num tom
  mais direto.

**Gerado pela IA:**

- **Código:** o código, as migrations, os testes, o Docker Compose e a documentação.
- **Decisões de detalhe:** registradas em
  [Quem decidiu o quê](ARCHITECTURE.md#quem-decidiu-o-quê).

**Erros da IA durante o processo:**

- Um commit feito com testes falhando (o Docker estava parado). Depois disso, todo commit
  passou a exigir a suíte verde.
- Uma afirmação errada sobre a API do domínio, corrigida no resumo da etapa.
- Um bug na validação de `money`, pego pelos testes de integração antes do commit.
- O healthcheck do Postgres no Compose, escrito na primeira etapa, liberava as migrations
  cedo demais com um volume novo. Apareceu num teste ponta a ponta e foi corrigido.

**Verificação feita pela IA:**

- **Testes:** typecheck e suíte completa antes de cada commit; concorrência repetida 20
  vezes.
- **Teste de mutação:** sem o `FOR UPDATE`, os testes de concorrência falham, o que mostra
  que eles pegam o problema.

**Revisado e testado por mim:**

- **Subida:** subi o projeto do zero com `docker compose up -d --build` e conferi
  `GET /health/ready` respondendo `ready: true`.
- **Testes:** rodei `bun test` e `bun run test:concurrency` e vi todos passarem.
- **API na mão, com `curl`:**
  - criei uma carteira com saldo inicial;
  - fiz uma BET e repeti a mesma requisição: veio `idempotentReplay: true` e o saldo não
    mudou;
  - mandei uma BET maior que o saldo e recebi 422 `INSUFFICIENT_FUNDS`;
  - fiz um REFUND da aposta e o saldo voltou ao valor inicial.
- **Banco:** conferi com `psql` que o saldo da carteira bate com a soma dos lançamentos
  do ledger.
- **Código que li e entendi:**
  - [dinheiro.ts](src/dominio/dinheiro.ts), como o dinheiro é guardado sem `number`;
  - [regras-aposta.ts](src/dominio/regras-aposta.ts), as regras de cada tipo de
    transação;
  - [processar-transacao-aposta.ts](src/aplicacao/processar-transacao-aposta.ts), o
    fluxo com lock e idempotência.
- **Alterações manuais:** não alterei código à mão. Os ajustes que quis, pedi à IA e
  revisei o resultado.
#   D e s a f i o _ J u n g l e  
 