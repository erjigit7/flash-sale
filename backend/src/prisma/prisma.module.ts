import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [AppConfig, PrismaService],
  exports: [AppConfig, PrismaService],
})
export class PrismaModule {}
