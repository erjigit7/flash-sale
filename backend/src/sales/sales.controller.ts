import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { SalesService } from './sales.service.js';
import { CreateSaleDto } from './sales.dto.js';
import { AuthGuard, Roles } from '../auth/auth.guard.js';
import { ClockService } from '../clock/clock.service.js';

@Controller()
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly clock: ClockService,
  ) {}

  /** Витрина публичная: смотреть можно без входа, купить — только после входа. */
  @Get('sales')
  async list() {
    const [sales, serverTime] = await Promise.all([this.sales.list(), this.clock.now()]);
    return { serverTime, sales };
  }

  @Get('sales/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const [sale, serverTime] = await Promise.all([this.sales.get(id), this.clock.now()]);
    return { serverTime, sale };
  }

  @Post('shop/sales')
  @UseGuards(AuthGuard)
  @Roles('SHOP')
  create(@Body() dto: CreateSaleDto) {
    return this.sales.create(dto);
  }
}
