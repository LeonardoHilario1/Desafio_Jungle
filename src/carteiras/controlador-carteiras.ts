import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { decodeCursor, eventContext, pageSize, parseBody, requiredMoney, requiredString, requireUuid } from '../api/requisicao';
import { OpenWallet } from '../aplicacao/abrir-carteira';
import { WageringQueries } from '../aplicacao/consultas-apostas';
import { AuthGuard } from '../autenticacao/guarda-autenticacao';
import type { ReconciliationView } from '../dominio/reconciliacao';
import { presentWallet, type WalletView } from './apresentacao-carteira';
import { presentLedgerPage, type LedgerPageView } from './apresentacao-ledger';

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(201)
  async open(
    @Body() rawBody: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<WalletView> {
    const body = parseBody(rawBody, ['playerId', 'initialBalance']);
    const wallet = await this.openWallet.execute(
      { playerId: requiredString(body, 'playerId'), initialBalance: requiredMoney(body, 'initialBalance') },
      eventContext(correlationId),
    );
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return presentWallet(await this.queries.wallet(requireUuid(walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<LedgerPageView> {
    const page = await this.queries.ledger(requireUuid(walletId, 'walletId'), decodeCursor(cursor), pageSize(limit));
    return presentLedgerPage(page);
  }

  // 200 mesmo com divergência: a conferência rodou, e o resultado vem em consistent
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    return (await this.queries.reconcile(requireUuid(walletId, 'walletId'))).toJSON();
  }
}
