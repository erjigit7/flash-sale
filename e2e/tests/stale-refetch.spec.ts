import { expect, test, type Page, type Route } from '@playwright/test';
import { buyerTab, card, createSale, uniqueEmail } from './helpers.ts';

/**
 * Гонка «ответ витрины против события остатка»: запрос /api/sales ушёл ДО изменения остатка,
 * а ответ пришёл ПОСЛЕ sale:stock. Запоздалый ответ не должен откатить свежий остаток.
 *
 * Как без sleep понять, что запоздалый ответ уже применён: в придержанном ответе название распродажи
 * подменяется меткой. Как только метка видна на экране — ответ в кэше, и остаток проверяется в том же рендере.
 */
const STALE_MARK = 'ЗАПОЗДАЛЫЙ ОТВЕТ';

/** Придерживать ответы /api/sales: ответ сервера берём в момент запроса, а отдаём браузеру по команде. */
async function holdSalesResponses(page: Page, saleId: string) {
  const held: { route: Route; json: { sales: { id: string; title: string }[] } }[] = [];
  let released = false;
  let arrived!: () => void;
  const firstHeld = new Promise<void>((r) => (arrived = r));
  await page.route('**/api/sales', async (route) => {
    // после «отпустить» новые запросы идут как обычно, без подмены
    if (released) return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    for (const s of json.sales) if (s.id === saleId) s.title = STALE_MARK;
    held.push({ route, json });
    arrived();
  });
  return {
    firstHeld,
    async releaseAll() {
      released = true;
      for (const h of held.splice(0)) await h.route.fulfill({ json: h.json });
    },
  };
}

/** Дождаться, что вкладка получила по сокету sale:stock этой распродажи (по кадрам WebSocket, без пауз). */
function stockFrameReceived(page: Page, saleId: string) {
  return new Promise<void>((resolve) => {
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        const text = typeof f.payload === 'string' ? f.payload : f.payload.toString();
        if (text.includes('sale:stock') && text.includes(saleId)) resolve();
      }),
    );
  });
}

test('перезапрос открытой витрины: запоздалый ответ не откатывает остаток, пришедший по событию', async ({ browser }) => {
  const saleId = await createSale({ title: `Гонка кэша ${Date.now()}`, totalQty: 2, startsInSeconds: 0 });
  const alice = await buyerTab(browser, uniqueEmail('buyer'));
  const bob = await buyerTab(browser, uniqueEmail('viewer'));
  await Promise.all([alice.goto('/'), bob.goto('/')]);
  await expect(card(bob, saleId).getByTestId('available')).toContainText('Осталось 2 из 2');

  // повод перезапросить витрину — старт другой распродажи (sale:started); ответ придерживаем
  const hold = await holdSalesResponses(bob, saleId);
  await createSale({ title: `Повод ${Date.now()}`, totalQty: 1, startsInSeconds: 1 });
  await hold.firstHeld;

  // пока ответ «в пути», Алиса берёт товар — Бобу приходит sale:stock с остатком 1
  await card(alice, saleId).getByRole('button', { name: 'В корзину' }).click();
  await expect(card(bob, saleId).getByTestId('available')).toContainText('Осталось 1 из 2');

  await hold.releaseAll();
  await expect(card(bob, saleId)).toContainText(STALE_MARK);
  expect(await card(bob, saleId).getByTestId('available').innerText()).toContain('Осталось 1 из 2');
});

test('первая загрузка витрины: событие остатка, пришедшее раньше ответа, не теряется', async ({ browser }) => {
  const saleId = await createSale({ title: `Первая загрузка ${Date.now()}`, totalQty: 2, startsInSeconds: 0 });
  const alice = await buyerTab(browser, uniqueEmail('buyer'));
  const bob = await buyerTab(browser, uniqueEmail('viewer'));
  await alice.goto('/');

  // у Боба все ответы витрины придерживаются: карточки в кэше ещё нет
  const hold = await holdSalesResponses(bob, saleId);
  const stockSeen = stockFrameReceived(bob, saleId);
  await bob.goto('/');
  await hold.firstHeld;
  await expect(bob.getByText('онлайн')).toBeVisible(); // сокет подключён и слушает

  await card(alice, saleId).getByRole('button', { name: 'В корзину' }).click();
  await stockSeen; // событие с остатком 1 пришло Бобу раньше, чем ответ витрины

  await hold.releaseAll();
  await expect(card(bob, saleId)).toContainText(STALE_MARK);
  expect(await card(bob, saleId).getByTestId('available').innerText()).toContain('Осталось 1 из 2');
});
