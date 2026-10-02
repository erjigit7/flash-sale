import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import { ClockService } from '../clock/clock.service.js';
import { ShopStatsService } from './shop-stats.service.js';

@Controller('shop')
@UseGuards(AuthGuard)
@Roles('SHOP')
export class ShopController {
  constructor(
    private readonly stats: ShopStatsService,
    private readonly clock: ClockService,
  ) {}

  /** Экран магазина: остатки, в корзинах, ждут оплаты, продано, снято, выручка — по каждой распродаже. */
  @Get('stats')
  async getStats() {
    const [sales, serverTime] = await Promise.all([this.stats.stats(), this.clock.now()]);
    return { serverTime, sales };
  }
}
