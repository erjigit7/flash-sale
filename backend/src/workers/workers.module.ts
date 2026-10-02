import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { WorkersService } from './workers.service.js';

@Module({
  imports: [ReservationsModule, SalesModule],
  providers: [WorkersService],
})
export class WorkersModule {}
