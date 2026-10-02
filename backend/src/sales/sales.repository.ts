import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type SaleStatus = 'UPCOMING' | 'LIVE' | 'ENDED';

export interface SaleView {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  priceCents: number;
  oldPriceCents: number | null;
  totalQty: number;
  available: number;
  withdrawnQty: number;
  maxPerOrder: number;
  startsAt: Date;
  endsAt: Date;
  version: number;
  /** Вычисляется по now() БД в момент запроса — не по часам Node и не по часам браузера */
  status: SaleStatus;
}

export interface CreateSaleInput {
  title: string;
  description: string;
  imageUrl: string | null;
  priceCents: number;
  oldPriceCents: number | null;
  totalQty: number;
  maxPerOrder: number;
  /** Абсолютное время старта или смещение от now() БД — что-то одно */
  startsAt: Date | null;
  startsInSeconds: number | null;
  durationSeconds: number;
}

const SALE_COLUMNS = Prisma.sql`
  id, title, description,
  image_url        AS "imageUrl",
  price_cents      AS "priceCents",
  old_price_cents  AS "oldPriceCents",
  total_qty        AS "totalQty",
  available,
  withdrawn_qty    AS "withdrawnQty",
  max_per_order    AS "maxPerOrder",
  starts_at        AS "startsAt",
  ends_at          AS "endsAt",
  version,
  CASE WHEN now() < starts_at THEN 'UPCOMING'
       WHEN now() < ends_at   THEN 'LIVE'
       ELSE 'ENDED' END AS status`;

@Injectable()
export class SalesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Витрина: сначала идущие, потом ближайшие, в конце завершённые. */
  list(): Promise<SaleView[]> {
    return this.prisma.$queryRaw<SaleView[]>`
      SELECT ${SALE_COLUMNS} FROM sales
      ORDER BY CASE WHEN now() < starts_at THEN 1 WHEN now() < ends_at THEN 0 ELSE 2 END,
               starts_at, created_at`;
  }

  async findById(id: string): Promise<SaleView | null> {
    const rows = await this.prisma.$queryRaw<SaleView[]>`
      SELECT ${SALE_COLUMNS} FROM sales WHERE id = ${id}::uuid`;
    return rows[0] ?? null;
  }

  /** Время старта считается от часов БД, если задано смещением (пресет «старт через 1 минуту»). */
  async create(input: CreateSaleInput): Promise<SaleView> {
    const rows = await this.prisma.$queryRaw<SaleView[]>`
      WITH t AS (
        SELECT COALESCE(${input.startsAt}::timestamptz,
                        now() + make_interval(secs => ${input.startsInSeconds ?? 0})) AS starts_at)
      INSERT INTO sales (title, description, image_url, price_cents, old_price_cents,
                         total_qty, available, max_per_order, starts_at, ends_at)
      SELECT ${input.title}, ${input.description}, ${input.imageUrl}, ${input.priceCents},
             ${input.oldPriceCents}, ${input.totalQty}, ${input.totalQty}, ${input.maxPerOrder},
             t.starts_at, t.starts_at + make_interval(secs => ${input.durationSeconds})
      FROM t
      RETURNING ${SALE_COLUMNS}`;
    return rows[0];
  }
}
