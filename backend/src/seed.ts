/**
 * Идемпотентный seed: перезапуск контейнера не плодит данные.
 * - аккаунт магазина: upsert по email;
 * - демо-распродажи: INSERT ... ON CONFLICT (slug) DO NOTHING, создаются только при первом запуске.
 * Время старта и конца считает сама БД (now()), как и всё остальное время в проекте.
 * Для свежего демо на экране магазина есть пресет «старт через 1 минуту».
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { AppConfig } from './config/app-config.js';
import { SHOP_EMAIL } from './auth/auth.constants.js';

type DemoSale = {
  slug: string;
  title: string;
  description: string;
  priceCents: number;
  oldPriceCents: number;
  totalQty: number;
  maxPerOrder: number;
  startInMinutes: number;
  durationMinutes: number;
};

const demoSales: DemoSale[] = [
  {
    slug: 'demo-headphones-last-unit',
    title: 'Наушники Pulse Pro',
    description: 'Всего одна пара: проверка гонки за последнюю единицу. Старт через 2 минуты после первого запуска.',
    priceCents: 4_990_00,
    oldPriceCents: 12_990_00,
    totalQty: 1,
    maxPerOrder: 1,
    startInMinutes: 2,
    durationMinutes: 30,
  },
  {
    slug: 'demo-coffee-machine',
    title: 'Кофемашина Brew One',
    description: 'Уже идёт. Не больше двух в одни руки.',
    priceCents: 19_900_00,
    oldPriceCents: 34_900_00,
    totalQty: 5,
    maxPerOrder: 2,
    startInMinutes: -1,
    durationMinutes: 60,
  },
  {
    slug: 'demo-backpack',
    title: 'Рюкзак Urban 25L',
    description: 'Скоро старт. До трёх штук в заказе.',
    priceCents: 2_490_00,
    oldPriceCents: 5_990_00,
    totalQty: 20,
    maxPerOrder: 3,
    startInMinutes: 10,
    durationMinutes: 60,
  },
];

async function main() {
  const config = new AppConfig();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  try {
    await prisma.user.upsert({
      where: { email: SHOP_EMAIL },
      update: {},
      create: { email: SHOP_EMAIL, name: 'Магазин', role: 'SHOP' },
    });

    let created = 0;
    for (const s of demoSales) {
      created += await prisma.$executeRaw`
        INSERT INTO sales (slug, title, description, price_cents, old_price_cents,
                           total_qty, available, max_per_order, starts_at, ends_at)
        VALUES (${s.slug}, ${s.title}, ${s.description}, ${s.priceCents}, ${s.oldPriceCents},
                ${s.totalQty}, ${s.totalQty}, ${s.maxPerOrder},
                now() + make_interval(mins => ${s.startInMinutes}),
                now() + make_interval(mins => ${s.startInMinutes + s.durationMinutes}))
        ON CONFLICT (slug) DO NOTHING`;
    }
    console.log(`seed: shop account ok, demo sales created: ${created}, already existed: ${demoSales.length - created}`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
