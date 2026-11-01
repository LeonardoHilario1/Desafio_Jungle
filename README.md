# Distributed Wagering Processor (MVP)

Serviço que recebe transações de apostas (BET, WIN, LOSS) de provedores de jogos,
atualiza o saldo das carteiras e mantém um ledger imutável. Ele continua correto com
mensagens repetidas, simultâneas e com várias instâncias rodando.

- **Decisões, trade-offs, limitações e a conferência das restrições do SPEC:**
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **Escopo original:** [SPEC.md](SPEC.md).

## Stack

Bun 1.4 · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 16 ·
SQS via LocalStack 4.4 · Docker Compose.

## Subir tudo

Pré-requisito: Docker.

```bash
docker compose up -d --build
curl localhost:3000/health/ready
```

A subida segue esta ordem:

1. `postgres` e `localstack` ficam saudáveis. O script de init do LocalStack cria a
   fila `wagering-events`.
2. `migrate` aplica as migrations e termina.
3. Só então o `app` sobe, na porta 3000.

## Usando a API

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/health/live` | 200 enquanto o processo está de pé |
| GET | `/health/ready` | 200 se PostgreSQL e fila SQS respondem; 503 com o detalhe |
| POST | `/wallets` | Cria carteira (`playerId`, `currency`, `initialBalance` opcional) |
| GET | `/wallets/:id` | Consulta carteira e saldo |
| POST | `/wagering/transactions` | BET, WIN ou LOSS; header `Idempotency-Key` obrigatório |

```bash
# carteira com saldo inicial
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"p1","currency":"BRL","initialBalance":"100.00"}'

# aposta (repetir com a mesma Idempotency-Key devolve a mesma resposta, sem debitar de novo)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: bet-123' \
  -d '{"walletId":"<id>","type":"BET","amount":"30.00","currency":"BRL"}'

# ganho referenciando a aposta pela chave dela
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: win-123' \
  -d '{"walletId":"<id>","type":"WIN","amount":"75.00","currency":"BRL","referenceKey":"bet-123"}'

# perda: valor zero, só liquida a aposta (exige uma BET anterior com a chave bet-456;
# se ela ainda não chegou, a resposta é 202 PENDING_REFERENCE)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: loss-456' \
  -d '{"walletId":"<id>","type":"LOSS","amount":"0","currency":"BRL","referenceKey":"bet-456"}'
```

- **Valores monetários** são sempre **strings** com até 2 casas. Um `amount` numérico é
  rejeitado.
- **Respostas:** 201 (processada), 202 (aguardando a BET referenciada), 422 (recusada
  por regra de negócio, com `failureCode`) e 409 (mesma chave com outro payload). A
  tabela completa de status e códigos está no
  [ARCHITECTURE.md](ARCHITECTURE.md#status-http).

Para ver os eventos publicados no SQS:

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events \
  --message-attribute-names All --max-number-of-messages 10
```

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
| `bun run typecheck` | `tsc --noEmit` com TypeScript strict |
| `bun test` | todos os testes (unitários e de integração) |
| `bun run test:unit` | só os unitários (não precisam de Docker) |
| `bun run test:integration` | só os de integração |
| `bun run test:concurrency` | testes de concorrência repetidos 20 vezes |
| `bun run migration:up` | aplica as migrations pendentes |
| `bun run migration:down` | reverte a última migration (recusa se houver dados financeiros) |

### Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
| --- | --- | --- | --- |
| `PORT` | sim | | porta HTTP |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | sim | | PostgreSQL |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | sim | | credenciais SQS (`test`/`test` no LocalStack) |
| `SQS_ENDPOINT` | sim | | endpoint do SQS (LocalStack) |
| `SQS_OUTBOX_QUEUE_NAME` | sim | | fila dos eventos |
| `OUTBOX_PUBLISHER_ENABLED` | não | `true` | liga o publisher do outbox nesta instância |
| `OUTBOX_POLL_INTERVAL_MS` | não | `500` | intervalo do publisher quando não há lote cheio |

Se faltar uma variável obrigatória, a aplicação não sobe.

## Testes

Os testes de integração usam o PostgreSQL e o LocalStack reais do Compose, com um banco
separado (`wagering_test`), sem mocks do banco.

```bash
docker compose up -d postgres localstack
bun test                     # 158 testes
bun run test:concurrency     # cenários de concorrência, 20 vezes
```

- **Concorrência:** os testes sobem **duas instâncias da aplicação** sobre o mesmo banco
  e conferem, no fim de cada cenário, que o saldo de cada carteira é igual ao saldo
  reconstruído pelo ledger.
- **Reset do banco:** as suítes recriam as tabelas do `wagering_test` a cada teste. O
  reset se recusa a rodar em bancos cujo nome não termina em `_test`.
- **Criação do `wagering_test`:** é feita por `docker/postgres/init` na **primeira**
  subida do volume. Se o volume já existia antes desse script, recrie-o com
  `docker compose down -v`.
- **Endereços:** podem ser trocados com `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_NAME` e
  `TEST_SQS_ENDPOINT`.

## Uso de IA

A implementação foi feita com apoio do **Claude Code** (Anthropic), etapa por etapa,
seguindo o `SPEC.md`. Ao fim de cada etapa a IA rodava os testes, explicava o que tinha
feito e por quê, e esperava a confirmação para seguir.

**Decidido por mim**

- **No `SPEC.md`:** stack, restrições invioláveis, lock pessimista por carteira com
  `CHECK (balance >= 0)` e `version`, idempotência por `Idempotency-Key` e `payloadHash`,
  outbox transacional, estados e `failureCode`, escopo do MVP e ordem das etapas.
- **Durante a implementação:** o saldo inicial como lançamento de abertura no ledger. A
  IA identificou que o SPEC não definia como a carteira recebe saldo e apresentou três
  opções; escolhi esta.

**Gerado pela IA**

- **Código:** todo o código, as migrations, os testes, o Docker Compose e estes
  documentos.
- **Decisões de detalhe:** a forma de BET/WIN/LOSS, os status HTTP, o tratamento de
  erros e o desenho do publisher. Estão registradas no `ARCHITECTURE.md`
  ([Quem decidiu o quê](ARCHITECTURE.md#quem-decidiu-o-quê)).
- **APIs das bibliotecas:** a IA consultou as definições de tipo das versões instaladas
  (MikroORM 7, NestJS 12, AWS SDK v3) antes de usá-las. Foi assim que encontrou, por
  exemplo, que o MikroORM 7 não lê mais `design:type` e que o Migrator não usa advisory
  lock.

**Erros da IA durante o processo, registrados por transparência**

- **Etapa 2:** fez um commit com testes de integração falhando, porque o encadeamento de
  comandos checava o código de saída errado. A causa das falhas era o Docker parado, não
  o código. Os testes foram rodados de novo sem mudança de arquivo e, dali em diante, o
  commit só acontecia se `bun test` passasse.
- **Etapa 3:** afirmou que a API pública do domínio não mudaria, mas ela mudou
  (`wallet.balance` virou `wallet.balance()`). A correção foi informada no resumo da
  etapa.

**Verificação feita pela IA**

- **Testes:** typecheck e suíte completa antes de cada commit. Testes de concorrência
  repetidos 20 vezes.
- **Teste de mutação:** sem o `FOR UPDATE`, os testes de concorrência falham.
- **Ponta a ponta:** cada etapa testada na stack do Compose.
- **Restrições:** auditoria por busca (uso de `number` em dinheiro, caches em memória,
  locks).

**Revisado e testado por mim**

_A preencher pelo responsável: o que foi revisado, o que foi executado e o que foi
alterado manualmente._
