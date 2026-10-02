import { Module } from '@nestjs/common';
import { PaymentGateway } from '../payments/payment-gateway.js';
import { PaymentsController } from '../payments/payments.controller.js';
import { OrdersController } from './orders.controller.js';
import { OrdersRepository } from './orders.repository.js';
import { OrdersService } from './orders.service.js';

@Module({
  controllers: [OrdersController, PaymentsController],
  providers: [OrdersRepository, OrdersService, PaymentGateway],
  exports: [OrdersService, PaymentGateway],
})
export class OrdersModule {}
