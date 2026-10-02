import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { MailModule } from '../mail/mail.module.js';
import { WorkersService } from './workers.service.js';

@Module({
  imports: [ReservationsModule, SalesModule, OrdersModule, MailModule],
  providers: [WorkersService],
})
export class WorkersModule {}
