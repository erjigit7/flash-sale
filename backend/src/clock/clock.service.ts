import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Единственный источник «текущего времени» для клиента — часы БД.
 * Все решения (старт, конец, удержание) принимаются в SQL через now(), поэтому и клиенту
 * отдаём то же время: таймеры в браузере синхронизируются именно с ним.
 */
@Injectable()
export class ClockService {
  constructor(private readonly prisma: PrismaService) {}

  async now(): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return row.now;
  }
}
