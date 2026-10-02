import type { PrismaService } from '../../src/prisma/prisma.service.js';

/**
 * Главный инвариант учёта: каждая единица партии ровно в одном месте —
 * на витрине, в корзине, в оплате, продана или снята с продажи.
 *   total_qty = available + ACTIVE + CHECKOUT + PURCHASED + withdrawn_qty
 */
export async function stockBreakdown(prisma: PrismaService, saleId: string) {
  const [row] = await prisma.$queryRaw<
    { total: number; available: number; withdrawn: number; active: number; checkout: number; purchased: number }[]
  >`
    SELECT s.total_qty AS total, s.available, s.withdrawn_qty AS withdrawn,
           COALESCE(sum(r.quantity) FILTER (WHERE r.status = 'ACTIVE'), 0)::int    AS active,
           COALESCE(sum(r.quantity) FILTER (WHERE r.status = 'CHECKOUT'), 0)::int  AS checkout,
           COALESCE(sum(r.quantity) FILTER (WHERE r.status = 'PURCHASED'), 0)::int AS purchased
      FROM sales s LEFT JOIN reservations r ON r.sale_id = s.id
     WHERE s.id = ${saleId}::uuid
     GROUP BY s.id`;
  return row;
}

export async function expectStockInvariant(prisma: PrismaService, saleId: string) {
  const b = await stockBreakdown(prisma, saleId);
  expect(b.available + b.active + b.checkout + b.purchased + b.withdrawn).toBe(b.total);
  return b;
}
