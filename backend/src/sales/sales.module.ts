import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';
import { SalesRepository } from './sales.repository.js';
import { SalesService } from './sales.service.js';
import { SaleScheduler } from './sale-scheduler.service.js';

@Module({
  controllers: [SalesController],
  providers: [SalesRepository, SalesService, SaleScheduler],
  exports: [SalesRepository, SalesService, SaleScheduler],
})
export class SalesModule {}
