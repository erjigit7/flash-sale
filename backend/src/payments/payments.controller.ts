import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../common/app-error.js';
import { OrdersService } from '../orders/orders.service.js';
import { PaymentGateway } from './payment-gateway.js';

interface WebhookBody {
  paymentId?: string;
  idempotencyKey?: string;
  status?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('payments')
export class PaymentsController {
  private readonly log = new Logger(PaymentsController.name);

  constructor(
    private readonly gateway: PaymentGateway,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Webhook провайдера. Подпись проверяется по сырому телу (HMAC). Доставка у провайдера at-least-once,
   * поэтому обработка идемпотентна: повтор — 200 без изменений. 2xx отвечаем и на дубль, иначе провайдер
   * будет слать его бесконечно.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string | undefined,
    @Body() body: WebhookBody,
  ) {
    if (!req.rawBody || !this.gateway.verifySignature(req.rawBody, signature)) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'bad_signature', 'Неверная подпись webhook');
    }
    const { paymentId, idempotencyKey: orderId, status } = body;
    if (!orderId || !UUID.test(orderId) || (status !== 'succeeded' && status !== 'declined')) {
      // финальным считаем только succeeded/declined; processing и мусор — игнорируем
      return { ok: true, ignored: true };
    }
    const applied = await this.orders.applyPaymentResult(orderId, status, paymentId ?? null);
    if (!applied) this.log.debug(`webhook for order ${orderId}: already applied (duplicate delivery)`);
    return { ok: true, applied };
  }
}
