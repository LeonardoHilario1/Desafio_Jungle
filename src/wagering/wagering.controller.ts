import { Body, Controller, Headers, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { ApiError } from '../api/api-error';
import { optionalString, parseBody, requiredString, requireUuid } from '../api/request';
import { AuthGuard } from '../auth/auth.guard';
import type { WagerType } from '../domain/wager-transaction';
import { httpStatusFor, presentTransaction, type TransactionView } from './transaction.presenter';
import { WageringService } from './wagering.service';

interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

// REFUND e ROLLBACK ficaram fora do MVP; chegam como 400 INVALID_TRANSACTION do domínio.
const FIELDS = ['walletId', 'type', 'amount', 'currency', 'referenceKey'] as const;

@Controller('wagering')
@UseGuards(AuthGuard)
export class WageringController {
  constructor(@Inject(WageringService) private readonly wagering: WageringService) {}

  @Post('transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<TransactionView> {
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key é obrigatório');
    }
    const body = parseBody(rawBody, FIELDS);

    const { transaction, replayed } = await this.wagering.submit({
      idempotencyKey,
      walletId: requireUuid(requiredString(body, 'walletId'), 'walletId'),
      type: requiredString(body, 'type') as WagerType,
      amount: requiredString(body, 'amount'),
      currency: requiredString(body, 'currency'),
      referenceKey: optionalString(body, 'referenceKey'),
    });

    res.status(httpStatusFor(transaction));
    res.setHeader('Idempotent-Replayed', String(replayed));
    return presentTransaction(transaction);
  }
}
