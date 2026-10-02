import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { WorkersService } from './workers.service.js';

@Module({
  imports: [ReservationsModule],
  providers: [WorkersService],
})
export class WorkersModule {}
