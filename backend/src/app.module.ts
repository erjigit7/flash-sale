import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { EventsModule } from './events/events.module.js';
import { ClockModule } from './clock/clock.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SalesModule } from './sales/sales.module.js';
import { ReservationsModule } from './reservations/reservations.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    PrismaModule,
    EventsModule,
    ClockModule,
    AuthModule,
    SalesModule,
    ReservationsModule,
    OrdersModule,
    RealtimeModule,
    WorkersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
