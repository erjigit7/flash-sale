import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ClockService } from '../clock/clock.service.js';
import { ReservationsService } from './reservations.service.js';

export class ReserveDto {
  @IsUUID()
  saleId!: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  quantity!: number;
}

@Controller('reservations')
@UseGuards(AuthGuard)
@Roles('BUYER')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly clock: ClockService,
  ) {}

  @Post()
  async reserve(@CurrentUser() user: AuthUser, @Body() dto: ReserveDto) {
    const r = await this.reservations.reserve(user.id, dto.saleId, dto.quantity);
    return {
      serverTime: await this.clock.now(),
      reservation: {
        id: r.id,
        saleId: r.saleId,
        quantity: r.quantity,
        unitPriceCents: r.unitPriceCents,
        status: 'ACTIVE',
        expiresAt: r.expiresAt,
      },
      sale: { id: r.saleId, available: r.available, version: r.version },
    };
  }

  /** Корзина (ACTIVE + CHECKOUT) или вся история позиций (?scope=all) */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('scope') scope?: string) {
    const [items, serverTime] = await Promise.all([
      this.reservations.listForUser(user.id, scope === 'all' ? 'all' : 'cart'),
      this.clock.now(),
    ]);
    return { serverTime, items };
  }

  @Delete(':id')
  @HttpCode(204)
  async release(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.reservations.release(user.id, id);
  }
}
