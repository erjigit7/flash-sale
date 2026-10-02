import { expect, test } from '@playwright/test';
import { buyerTab, card, createSaleFull, HOLD_TTL_SECONDS, mailsTo, uniqueEmail } from './helpers.ts';

/**
 * «По окончании распродажи непроданное снимается, неоплаченные корзины очищаются, их владельцы получают уведомление».
 * Распродажа короче удержания: к концу товар всё ещё лежит в корзине.
 */
test('конец распродажи с товаром в корзине → корзина очищена, уведомление и письмо владельцу, остаток снят', async ({ browser }) => {
  const DURATION = 12;
  test.skip(HOLD_TTL_SECONDS <= DURATION, 'удержание должно быть длиннее распродажи');
  test.setTimeout(60_000);

  const sale = await createSaleFull({ title: `Конец ${Date.now()}`, totalQty: 2, startsInSeconds: 0, durationSeconds: DURATION });
  const aliceEmail = uniqueEmail('late');
  const alice = await buyerTab(browser, aliceEmail);
  const bob = await buyerTab(browser, uniqueEmail('viewer'));
  await Promise.all([alice.goto('/'), bob.goto('/')]);

  await card(alice, sale.id).getByRole('button', { name: 'В корзину' }).click();
  await alice.goto('/cart');
  await expect(alice.getByText('Удерживается ещё')).toBeVisible();

  // распродажа закончилась: уведомление приходит само, корзина пуста
  const untilEnd = { timeout: DURATION * 1000 + 15_000 };
  await expect(alice.locator('.toast', { hasText: 'Распродажа завершилась' })).toBeVisible(untilEnd);
  await expect(alice.getByText('Корзина пуста')).toBeVisible();

  // у второй вкладки: распродажа завершена, непроданное снято (на витрине 0)
  await expect(card(bob, sale.id).locator('.buy-row')).toContainText('Распродажа завершена');
  await expect(card(bob, sale.id).getByTestId('available')).toContainText('Осталось 0 из 2');

  // уведомление в кабинете и история позиции
  await alice.goto('/account');
  await expect(alice.getByText('Распродажа завершилась').first()).toBeVisible();
  await expect(alice.getByText('Распродажа закончилась до оплаты')).toBeVisible();

  // письмо — ровно одно
  await expect.poll(async () => (await mailsTo(aliceEmail)).length, { timeout: 15_000 }).toBe(1);
  expect((await mailsTo(aliceEmail))[0].Subject).toContain('завершилась');
});
