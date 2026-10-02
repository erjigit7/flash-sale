import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';
import { SalesRepository } from './sales.repository.js';
import { SalesService } from './sales.service.js';

@Module({
  controllers: [SalesController],
  providers: [SalesRepository, SalesService],
  exports: [SalesRepository, SalesService],
})
export class SalesModule {}
