import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
