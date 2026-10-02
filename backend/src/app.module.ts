import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { ClockModule } from './clock/clock.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [PrismaModule, ClockModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
