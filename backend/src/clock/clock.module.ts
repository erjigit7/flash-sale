import { Global, Module } from '@nestjs/common';
import { ClockController } from './clock.controller.js';
import { ClockService } from './clock.service.js';

@Global()
@Module({
  controllers: [ClockController],
  providers: [ClockService],
  exports: [ClockService],
})
export class ClockModule {}
