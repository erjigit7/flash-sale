import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { AppConfig } from '../config/app-config.js';
import { DomainEvents } from '../events/domain-events.js';
import { SalesRepository, type SaleView } from './sales.repository.js';
import { SaleScheduler } from './sale-scheduler.service.js';
import type { CreateSaleDto } from './sales.dto.js';

@Injectable()
export class SalesService {
  private readonly log = new Logger(SalesService.name);

  constructor(
    private readonly repo: SalesRepository,
    private readonly scheduler: SaleScheduler,
    private readonly config: AppConfig,
    private readonly events: DomainEvents,
  ) {}

  list(): Promise<SaleView[]> {
    return this.repo.list();
  }

  async get(id: string): Promise<SaleView> {
    const sale = await this.repo.findById(id);
    if (!sale) throw new AppError(HttpStatus.NOT_FOUND, 'sale_not_found', 'Распродажа не найдена');
    return sale;
  }

  async create(dto: CreateSaleDto): Promise<SaleView> {
    if ((dto.startsAt === undefined) === (dto.startsInSeconds === undefined)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'invalid_start',
        'Укажите либо startsAt, либо startsInSeconds',
      );
    }
    const maxPerOrder = dto.maxPerOrder ?? 1;
    if (maxPerOrder > dto.totalQty) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'invalid_max_per_order',
        'Лимит на заказ не может быть больше партии',
      );
    }
    if (dto.oldPriceCents !== undefined && dto.oldPriceCents <= dto.priceCents) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_old_price', 'Старая цена должна быть выше цены распродажи');
    }
    const sale = await this.repo.create({
      title: dto.title.trim(),
      description: dto.description?.trim() ?? '',
      imageUrl: dto.imageUrl ?? null,
      priceCents: dto.priceCents,
      oldPriceCents: dto.oldPriceCents ?? null,
      totalQty: dto.totalQty,
      maxPerOrder,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      startsInSeconds: dto.startsInSeconds ?? null,
      durationSeconds: dto.durationSeconds,
    });
    // INSERT — один оператор, к этому моменту он уже закоммичен: можно сообщать витринам
    this.events.emit('sale.created', { saleId: sale.id });
    // распродажа «через минуту» должна получить точный таймер старта сразу, не дожидаясь цикла воркера
    // распродажа уже в БД и показана всем: сбой планирования не должен превращаться в 500 (повтор дал бы дубль);
    // таймер всё равно поставит цикл воркера
    if (this.config.workersEnabled) {
      await this.scheduler.planUpcoming().catch((e: unknown) => this.log.warn(`planUpcoming failed: ${(e as Error).message}`));
    }
    return sale;
  }
}
