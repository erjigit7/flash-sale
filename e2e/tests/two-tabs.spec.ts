import { expect, test } from '@playwright/test';
import { buyerTab, card, createSale, mailsTo, ordersOf, shopTab, stubPayments, uniqueEmail } from './helpers.ts';

/**
 * Две вкладки (два независимых browser context, два покупателя) против настоящего стека.
 * Проверяем то, что видит человек: кнопки, остатки, статусы — без перезагрузки страниц.
 */
test('старт открывается одновременно; последнюю единицу получает один, второму «закончилось»; остаток обновляется у обоих', async ({ browser }) => {
  const saleId = await createSale({ title: `Гонка ${Date.now()}`, totalQty: 1, startsInSeconds: 6 });
  const alice = await buyerTab(browser, uniqueEmail('alice'));
  const bob = await buyerTab(browser, uniqueEmail('bob'));
  await Promise.all([alice.goto('/'), bob.goto('/')]);

  // до старта: страница открыта заранее, но купить нельзя
  for (const page of [alice, bob]) {
    const button = card(page, saleId).locator('.buy-row button');
    await expect(button).toHaveText(/Старт через/);
    await expect(button).toBeDisabled();
  }

  // момент старта: кнопка открывается в обеих вкладках (по серверным часам)
  const unlocked = await Promise.all(
    [alice, bob].map(async (page) => {
      await expect(card(page, saleId).getByRole('button', { name: 'В корзину' })).toBeEnabled({ timeout: 15_000 });
      return Date.now();
    }),
  );
  expect(Math.abs(unlocked[0] - unlocked[1])).toBeLessThan(1500);

  // оба жмут одновременно
  await Promise.all([alice, bob].map((page) => card(page, saleId).getByRole('button', { name: 'В корзину' }).click()));

  // ровно один получил товар, у второго — «Закончилось»; остаток 0 виден обоим без перезагрузки
  for (const page of [alice, bob]) {
    await expect(card(page, saleId).getByTestId('available')).toContainText('Осталось 0 из 1');
  }
  const states = await Promise.all(
    [alice, bob].map((page) =>
      card(page, saleId)
        .locator('.buy-row')
        .innerText()
        .then((t) => (t.includes('В корзине') ? 'won' : t.includes('Закончилось') ? 'lost' : t)),
    ),
  );
  expect(states.sort()).toEqual(['lost', 'won']);
});

test('двойной клик «оплатить» → один заказ; зависшая оплата держит товар; ответ заглушки → «Оплачен» и одно письмо', async ({ browser }) => {
  const saleId = await createSale({ title: `Оплата ${Date.now()}`, totalQty: 1, startsInSeconds: 0 });
  const aliceEmail = uniqueEmail('payer');
  const alice = await buyerTab(browser, aliceEmail);
  const bob = await buyerTab(browser, uniqueEmail('watcher'));
  const shop = await shopTab(browser);
  await Promise.all([alice.goto('/'), bob.goto('/')]);

  await card(alice, saleId).getByRole('button', { name: 'В корзину' }).click();
  await expect(card(bob, saleId).locator('.buy-row')).toContainText('Закончилось');

  // корзина: сценарий «зависнуть», двойной клик по «Оплатить»
  await alice.goto('/cart');
  await alice.getByRole('radio', { name: /Зависнуть/ }).click();
  await alice.getByRole('button', { name: /Оплатить/ }).dblclick();
  await expect(alice.getByText('Ожидаем ответ платёжной системы')).toBeVisible();

  const orders = await ordersOf(alice);
  const mine = orders.filter((o) => o.saleId === saleId);
  expect(mine).toHaveLength(1);
  expect(mine[0].status).toBe('PENDING');
  await expect.poll(async () => (await stubPayments(mine[0].id)).length).toBe(1);

  // магазин видит «ждут оплаты» вживую; товар не вернулся на витрину
  const row = shop.getByTestId(`stats-${saleId}`);
  await expect(row.locator('td').nth(5)).toHaveText('1'); // «Ждут оплаты»
  await expect(card(bob, saleId).getByTestId('available')).toContainText('Осталось 0 из 1');

  // заглушка «отвисла»: подтверждаем платёж (как кнопкой в её панели)
  await alice.goto('/account');
  const [payment] = await stubPayments(mine[0].id);
  const resolved = await fetch(`${process.env.PAYMENT_STUB_URL ?? 'http://localhost:4000'}/payments/${payment.id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ result: 'succeeded' }),
  });
  expect(resolved.status).toBe(200);

  // статус в кабинете меняется сам, без перезагрузки
  await expect(alice.getByTestId(`order-${mine[0].id}`)).toContainText('Оплачен');
  await expect(row.locator('td').nth(6)).toHaveText('1'); // «Продано»
  await expect.poll(async () => (await mailsTo(aliceEmail)).length, { timeout: 15_000 }).toBe(1);
  expect((await mailsTo(aliceEmail))[0].Subject).toContain('оплачен');
});
