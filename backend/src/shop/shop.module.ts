import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ShopController } from './shop.controller.js';
import { ShopStatsService } from './shop-stats.service.js';

@Module({
  imports: [RealtimeModule],
  controllers: [ShopController],
  providers: [ShopStatsService],
})
export class ShopModule {}
