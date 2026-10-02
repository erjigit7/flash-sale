import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { SalesRepository, type SaleView } from './sales.repository.js';
import type { CreateSaleDto } from './sales.dto.js';

@Injectable()
export class SalesService {
  constructor(private readonly repo: SalesRepository) {}

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
    return this.repo.create({
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
  }
}
