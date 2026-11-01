import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { optionalString, parseBody, requiredString, requireUuid } from '../api/request';
import { AuthGuard } from '../auth/auth.guard';
import { presentWallet, type WalletView } from './wallet.presenter';
import { WalletsService } from './wallets.service';

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(@Inject(WalletsService) private readonly wallets: WalletsService) {}

  @Post()
  @HttpCode(201)
  async open(@Body() rawBody: unknown): Promise<WalletView> {
    const body = parseBody(rawBody, ['playerId', 'currency', 'initialBalance']);
    const wallet = await this.wallets.open({
      playerId: requiredString(body, 'playerId'),
      currency: requiredString(body, 'currency'),
      initialBalance: optionalString(body, 'initialBalance'),
    });
    return presentWallet(wallet);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<WalletView> {
    return presentWallet(await this.wallets.get(requireUuid(id, 'id')));
  }
}
