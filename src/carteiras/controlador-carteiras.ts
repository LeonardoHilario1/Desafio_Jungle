import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { eventContext, parseBody, requiredMoney, requiredString, requireUuid } from '../api/requisicao';
import { OpenWallet } from '../aplicacao/abrir-carteira';
import { WageringQueries } from '../aplicacao/consultas-apostas';
import { AuthGuard } from '../autenticacao/guarda-autenticacao';
import { presentWallet, type WalletView } from './apresentacao-carteira';

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
}
