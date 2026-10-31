# SPEC — Plano B do desafio "Distributed Wagering Processor"

Uso: colocar este arquivo na raiz de um repositório **separado** do meu trabalho principal
e pedir ao Claude Code para seguir a spec. Se eu terminar a minha versão, esta é descartada.

## Prompt para colar no Claude Code

> Leia o `SPEC.md` inteiro antes de escrever qualquer código. Implemente o desafio com o
> **escopo reduzido (MVP)** descrito, na ordem das etapas. Pare no final de cada etapa,
> rode os testes e me explique em poucas linhas o que foi feito e por quê, antes de seguir.
> Respeite as restrições invioláveis. O que ficou fora do escopo deve ser documentado como
> limitação, e não implementado pela metade. Não invente APIs de bibliotecas: se não tiver
> certeza de uma assinatura, consulte a documentação da versão instalada ou me avise.
> Registre o uso de IA na seção correspondente do README.

## Contexto

Serviço financeiro que recebe transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) de
provedores de jogos, atualiza o saldo da carteira e mantém um ledger imutável. A entrega
das mensagens é at-least-once: o sistema deve continuar correto com mensagens repetidas,
simultâneas e com falhas no meio do processamento.

## Stack obrigatória

Bun 1.x · TypeScript estrito · NestJS · PostgreSQL · **MikroORM** · SQS via LocalStack ·
Docker Compose · migrations versionadas e reversíveis. Prisma está fora do escopo.

## Restrições invioláveis (qualquer violação invalida a entrega)

1. Nunca usar `number`, `float` ou `double` para dinheiro. Usar `Money` (decimal em string,
   escala 2) e `numeric(18,2)` no banco.
2. Nenhuma idempotência baseada em memória.
3. Não confiar só em SQS FIFO para consistência.
4. Não publicar evento antes do commit da transação financeira.
5. Nunca sobrescrever ou excluir lançamentos do ledger.
6. Sem lock global compartilhado por todas as carteiras. O lock é por carteira.
7. Proibido saldo como ler → calcular → gravar sem controle de concorrência.
8. Deve estar correto com várias instâncias da aplicação.
9. Unicidade, imutabilidade e não-negatividade aplicadas **no schema do banco**, não só no
   código.
10. Os testes de integração usam PostgreSQL real em container, e não mocks do banco.

## Decisões já tomadas (seguir)

- **Concorrência:** lock pessimista por carteira (`SELECT ... FOR UPDATE`) dentro da
  transação, mais `CHECK (balance >= 0)`. Coluna `version` incrementada quando o saldo muda.
- **Idempotência:** header `Idempotency-Key` obrigatório, `UNIQUE` no banco, `payloadHash`
  (SHA-256 do JSON canônico com chaves ordenadas, só campos de negócio). Mesma chave com
  payload diferente é conflito, e não replay.
- **Outbox:** evento gravado na mesma transação do saldo e do ledger; um publisher o envia
  ao SQS e marca como publicado, seguro com mais de um publisher.
- **Estados:** PENDING, PENDING_REFERENCE, PROCESSED, REJECTED, FAILED (os três últimos
  são terminais). `failureCode` estável e legível por máquina.

## Escopo do MVP (fazer)

Etapa 1 — Base: Docker Compose (PostgreSQL + LocalStack), NestJS com Bun, MikroORM, primeira
migration, `GET /health/live` e `GET /health/ready`.

Etapa 2 — Domínio: `Money` (imutável, entradas inválidas rejeitadas, moedas diferentes
geram erro), `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, com construtor privado e
factories estáticas. Testes unitários.

Etapa 3 — Schema: constraints (`UNIQUE` de carteira por jogador+moeda, `UNIQUE` da chave de
idempotência, `CHECK (balance >= 0)`, ledger imutável) e migrations reversíveis.

Etapa 4 — API: `POST /wallets`, `GET /wallets/:id`, `POST /wagering/transactions` para
**BET, WIN e LOSS**, com idempotência e lock. Mapeamento de status HTTP consistente.

Etapa 5 — Outbox: gravação na mesma transação e publisher no SQS.

Etapa 6 — Testes de integração e de concorrência:
- saldo 100, duas BET de 80 em paralelo → exatamente uma PROCESSED, a outra REJECTED por
  saldo insuficiente, saldo final 20.00, um único débito no ledger;
- a mesma BET enviada 50 vezes em paralelo → um único débito;
- invariante final: saldo da carteira igual ao saldo reconstruído pelo ledger.

Etapa 7 — Documentação: `README.md` (setup e comandos) e `ARCHITECTURE.md` (decisões,
trade-offs e limitações).

## Se houver tempo (opcional)

Consumidor SQS com inbox · REFUND e ROLLBACK · `GET` do ledger com cursor · reconciliação.

## Fora do escopo (documentar como limitação, não implementar pela metade)

Autenticação (deixar um `AuthGuard` sem efeito como ponto de extensão e descrever o desenho
com IdP externo) · reprocessamento de PENDING_REFERENCE com backoff · métricas completas ·
teste de carga.

## Regras de trabalho

- Um commit por etapa, com mensagem clara; testes passando antes de cada commit.
- Em caso de dúvida de decisão, perguntar em vez de escolher em silêncio.
- Manter o `ARCHITECTURE.md` atualizado a cada decisão relevante.
- Código simples e legível; sem abstrações que o desafio não pediu.
- Declarar explicitamente nas entidades o tipo das colunas, sem depender de inferência de
  metadados de decorators no Bun.

## Critérios de aceite

- `docker compose up` sobe tudo e o `ready` responde.
- Todos os testes passam, inclusive os de concorrência, rodados de forma repetida.
- Nenhuma restrição inviolável quebrada (conferir a lista acima item a item).
- README e ARCHITECTURE.md refletem o que foi de fato implementado, com as limitações.

## Seção obrigatória no README: uso de IA

Descrever com franqueza que a implementação foi feita com apoio do Claude Code, o que foi
decidido por mim (as decisões acima), o que a IA gerou e o que eu revisei e testei.
