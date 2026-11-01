# Distributed Wagering Processor (MVP)

Serviço que processa transações de apostas, atualiza o saldo de carteiras e mantém um
ledger imutável, continuando correto com entrega at-least-once. As decisões de desenho
estão em [ARCHITECTURE.md](ARCHITECTURE.md) e o escopo em [SPEC.md](SPEC.md).

> Status: **Etapas 1 e 2** concluídas: infraestrutura, health checks, pipeline de
> migrations e modelo de domínio (`src/domain`) com testes unitários. Schema e API ainda
> não foram implementados.

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
