import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiError } from '../api/erro-api';
import { eventContext, optionalString, parseBody, requiredMoney, requiredString, requireUuid } from '../api/requisicao';
import { ProcessWagerTransaction } from '../aplicacao/processar-transacao-aposta';
import { WageringQueries } from '../aplicacao/consultas-apostas';
import { AuthGuard } from '../autenticacao/guarda-autenticacao';
import type { SubmittableKind } from '../dominio/transacao-aposta';
import {
  httpStatusFor,
  presentSubmit,
  presentTransaction,
  type SubmitView,
  type TransactionView,
} from './apresentacao-transacao';

interface HttpResponse {
  status(code: number): unknown;
}

const FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const;

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  /** Idempotency-Key é obrigatório e manda em tudo; o padrão sugerido é "{providerId}:{externalTransactionId}" */
  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<SubmitView> {
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key é obrigatório');
    }
    const body = parseBody(rawBody, FIELDS);

    const result = await this.processWager.execute(
      {
        idempotencyKey,
        providerId: requiredString(body, 'providerId'),
        externalTransactionId: requiredString(body, 'externalTransactionId'),
        playerId: requiredString(body, 'playerId'),
        walletId: requireUuid(requiredString(body, 'walletId'), 'walletId'),
        roundId: requiredString(body, 'roundId'),
        gameId: requiredString(body, 'gameId'),
        kind: requiredString(body, 'kind') as SubmittableKind,
        money: requiredMoney(body, 'money'),
        referenceExternalTransactionId: optionalString(body, 'referenceExternalTransactionId'),
      },
      eventContext(correlationId, idempotencyKey),
    );

    res.status(httpStatusFor(result.transaction));
    return presentSubmit(result);
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    return presentTransaction(await this.queries.transaction(requireUuid(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return presentTransaction(await this.queries.transactionByExternalId(providerId, externalTransactionId));
  }
}
