import type { PrismaService } from '../../src/prisma/prisma.service.js';

export interface SaleFixture {
  totalQty?: number;
  maxPerOrder?: number;
  priceCents?: number;
  /** Старт относительно now() БД, секунды (отрицательное — уже идёт) */
  startsIn?: number;
  /** Конец относительно now() БД, секунды */
  endsIn?: number;
}

/** Создаёт распродажу напрямую в БД; время — относительно часов БД, как в проде. */
export async function createSale(prisma: PrismaService, f: SaleFixture = {}): Promise<string> {
  const totalQty = f.totalQty ?? 1;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO sales (title, price_cents, total_qty, available, max_per_order, starts_at, ends_at)
    VALUES ('Тестовый товар', ${f.priceCents ?? 1000_00}, ${totalQty}, ${totalQty}, ${f.maxPerOrder ?? 1},
            now() + make_interval(secs => ${f.startsIn ?? -60}),
            now() + make_interval(secs => ${f.endsIn ?? 3600}))
    RETURNING id`;
  return rows[0].id;
}

/**
 * «Перематывает время» для распродажи: сдвигает её окно относительно now() БД.
 * Так тесты проверяют старт и окончание без sleep и без подмены часов.
 */
export async function setSaleWindow(prisma: PrismaService, saleId: string, startsIn: number, endsIn: number) {
  await prisma.$executeRaw`
    UPDATE sales SET starts_at = now() + make_interval(secs => ${startsIn}),
                     ends_at   = now() + make_interval(secs => ${endsIn})
    WHERE id = ${saleId}::uuid`;
}

export async function saleRow(prisma: PrismaService, saleId: string) {
  return prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
}
