import { Body, Controller, Get, Headers, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IsEnum, IsUUID } from 'class-validator';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AppError } from '../common/app-error.js';
import { PaymentScenario } from '../generated/prisma/enums.js';
import { OrdersService } from './orders.service.js';

export class CheckoutDto {
  @IsUUID()
  reservationId!: string;

  /** Тестовый сценарий для заглушки — аналог тестовых карт у настоящих провайдеров */
  @IsEnum(PaymentScenario)
  scenario!: PaymentScenario;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

@Controller('orders')
@UseGuards(AuthGuard)
@Roles('BUYER')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Создать заказ и начать оплату. Заголовок Idempotency-Key обязателен: клиент генерирует его
   * один раз на позицию корзины и повторяет при любом повторе запроса.
   * 201 — заказ создан, 200 — повтор (возвращаем тот же заказ).
   */
  @Post()
  async checkout(
    @CurrentUser() user: AuthUser,
    @Body() dto: CheckoutDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'idempotency_key_required', 'Нужен заголовок Idempotency-Key');
    }
    const { order, replay } = await this.orders.checkout(user.id, dto.reservationId, key, dto.scenario);
    res.status(replay ? HttpStatus.OK : HttpStatus.CREATED);
    return { order, replay };
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return { orders: await this.orders.listForUser(user.id) };
  }
}
