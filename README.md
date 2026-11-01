# Distributed Wagering Processor (MVP)

Serviço que processa transações de apostas, atualiza o saldo de carteiras e mantém um
ledger imutável, continuando correto com entrega at-least-once. As decisões de desenho
estão em [ARCHITECTURE.md](ARCHITECTURE.md) e o escopo em [SPEC.md](SPEC.md).

> Status: **Etapas 1 a 5** concluídas: infraestrutura, domínio, schema com constraints,
> API de carteiras e apostas (BET, WIN, LOSS) com idempotência e lock por carteira, e
> outbox transacional publicado no SQS.

Para ver os eventos publicados na stack do Compose:

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events \
  --message-attribute-names All --max-number-of-messages 10
```

## Stack

Bun 1.4 · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 16 ·
SQS via LocalStack 4.4 · Docker Compose.

## Subir tudo

```bash
docker compose up -d --build
curl localhost:3000/health/ready
```

Ordem de subida: `postgres` e `localstack` ficam saudáveis, `migrate` aplica as migrations
e termina, e só então o `app` sobe. O script de init do LocalStack cria a fila `wagering-events`.

## Endpoints

| Método | Rota            | Descrição                                                              |
| ------ | --------------- | ---------------------------------------------------------------------- |
| GET    | `/health/live`  | 200 enquanto o processo está de pé; não consulta dependências.          |
| GET    | `/health/ready` | 200 se PostgreSQL e a fila SQS respondem; 503 com o detalhe de cada check. |
| POST   | `/wallets`      | Cria carteira (`playerId`, `currency`, `initialBalance` opcional).      |
| GET    | `/wallets/:id`  | Consulta carteira e saldo.                                             |
| POST   | `/wagering/transactions` | BET, WIN ou LOSS. Header `Idempotency-Key` obrigatório.     |

Exemplo:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"p1","currency":"BRL","initialBalance":"100.00"}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: bet-123' \
  -d '{"walletId":"<id>","type":"BET","amount":"30.00","currency":"BRL"}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: win-123' \
  -d '{"walletId":"<id>","type":"WIN","amount":"75.00","currency":"BRL","referenceKey":"bet-123"}'
```

Valores monetários são sempre strings com até 2 casas. Status HTTP e códigos de erro
estão no [ARCHITECTURE.md](ARCHITECTURE.md#status-http).

## Desenvolvimento local

Pré-requisitos: Bun 1.4+ e Docker.

```bash
bun install
cp .env.example .env          # o Bun carrega o .env automaticamente
docker compose up -d postgres localstack
bun run migration:up
bun run start
```

| Comando                  | O que faz                                        |
| ------------------------ | ------------------------------------------------ |
| `bun run typecheck`      | `tsc --noEmit` com TypeScript strict             |
| `bun test`               | testes unitários e de integração                 |
| `bun run test:unit`      | só os unitários (não precisam de Docker)         |
| `bun run test:integration` | só os de integração                            |
| `bun run migration:up`   | aplica as migrations pendentes                   |
| `bun run migration:down` | reverte a última migration                       |

## Testes

Os testes de integração usam o PostgreSQL e o LocalStack reais do Compose, com um banco
separado (`wagering_test`), sem mocks do banco. Antes de rodar:

```bash
docker compose up -d postgres localstack
bun test
```

As suítes recriam as tabelas do `wagering_test` a cada teste. Não aponte os testes para
outro banco: o reset se recusa a rodar em bancos cujo nome não termina em `_test`.

O banco `wagering_test` é criado por `docker/postgres/init` na **primeira** subida do
volume. Se o volume já existia antes desse script, recrie-o com `docker compose down -v`.
Os endereços podem ser trocados com `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_NAME` e
`TEST_SQS_ENDPOINT`.

## Uso de IA

A implementação foi feita com apoio do Claude Code (Anthropic).

- **Decidido por mim:** stack, restrições invioláveis, lock pessimista por carteira,
  modelo de idempotência com `payloadHash`, outbox transacional, estados e escopo do MVP
  (tudo isso no `SPEC.md`).
- **Gerado pela IA:** o código e a configuração de cada etapa, a partir da spec. As
  escolhas de detalhe tomadas pela IA estão registradas no `ARCHITECTURE.md`.
- **Revisado e testado por mim:** _a preencher a cada etapa._
