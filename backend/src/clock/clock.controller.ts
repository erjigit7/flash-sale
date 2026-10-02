import { Controller, Get } from '@nestjs/common';
import { ClockService } from './clock.service.js';

@Controller('time')
export class ClockController {
  constructor(private readonly clock: ClockService) {}

  @Get()
  async time() {
    return { serverTime: (await this.clock.now()).toISOString() };
  }
}
