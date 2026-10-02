import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';
import { SalesRepository } from './sales.repository.js';
import { SalesService } from './sales.service.js';
import { SaleScheduler } from './sale-scheduler.service.js';
import { SaleFinalizer } from './sale-finalizer.service.js';

@Module({
  controllers: [SalesController],
  providers: [SalesRepository, SalesService, SaleScheduler, SaleFinalizer],
  exports: [SalesRepository, SalesService, SaleScheduler, SaleFinalizer],
})
export class SalesModule {}
