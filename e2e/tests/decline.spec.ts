import { expect, test } from '@playwright/test';
import { buyerTab, card, createSale, mailsTo, ordersOf, uniqueEmail } from './helpers.ts';

/** Платёжка отклонила оплату: заказ «отклонён», товар вернулся на витрину, письмо об отказе — одно. */
test('отказ оплаты → заказ отклонён, товар снова на витрине у всех, одно письмо', async ({ browser }) => {
  const saleId = await createSale({ title: `Отказ ${Date.now()}`, totalQty: 1, startsInSeconds: 0 });
  const aliceEmail = uniqueEmail('declined');
  const alice = await buyerTab(browser, aliceEmail);
  const bob = await buyerTab(browser, uniqueEmail('next'));
  await Promise.all([alice.goto('/'), bob.goto('/')]);

  await card(alice, saleId).getByRole('button', { name: 'В корзину' }).click();
  await expect(card(bob, saleId).locator('.buy-row')).toContainText('Закончилось');

  await alice.goto('/cart');
  await alice.getByRole('radio', { name: /Отклонить/ }).click();
  await alice.getByRole('button', { name: /Оплатить/ }).click();
  await expect(alice.locator('.toast', { hasText: 'Оплата отклонена' })).toBeVisible();

  const [order] = (await ordersOf(alice)).filter((o) => o.saleId === saleId);
  await alice.goto('/account');
  await expect(alice.getByTestId(`order-${order.id}`)).toContainText('Оплата отклонена');
  await expect(alice.getByText('Возвращено на витрину')).toBeVisible();

  // у второй вкладки товар вернулся без перезагрузки, его можно купить
  await expect(card(bob, saleId).getByTestId('available')).toContainText('Осталось 1 из 1');
  await card(bob, saleId).getByRole('button', { name: 'В корзину' }).click();
  await expect(card(bob, saleId).locator('.buy-row')).toContainText('В корзине');

  await expect.poll(async () => (await mailsTo(aliceEmail)).length, { timeout: 15_000 }).toBe(1);
  expect((await mailsTo(aliceEmail))[0].Subject).toContain('не прошла');
});
