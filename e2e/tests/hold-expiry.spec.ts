import { expect, test } from '@playwright/test';
import { buyerTab, card, createSale, HOLD_TTL_SECONDS, uniqueEmail } from './helpers.ts';

/**
 * «Товар в корзине удерживается N минут. Не оплатил — вернулся на витрину, и остальные видят это сразу».
 * Бэкенд запущен с коротким удержанием (scripts/run-e2e.mjs), поэтому ждём реальные секунды, а не 10 минут.
 */
test('не оплатил за время удержания → товар вернулся на витрину, второй покупатель видит это без перезагрузки', async ({ browser }) => {
  test.skip(HOLD_TTL_SECONDS > 60, 'нужен короткий HOLD_TTL_SECONDS — запускайте через scripts/run-e2e.mjs');
  test.setTimeout((HOLD_TTL_SECONDS + 45) * 1000);

  const saleId = await createSale({ title: `Удержание ${Date.now()}`, totalQty: 1, startsInSeconds: 0 });
  const alice = await buyerTab(browser, uniqueEmail('holder'));
  const bob = await buyerTab(browser, uniqueEmail('waiter'));
  await Promise.all([alice.goto('/'), bob.goto('/')]);

  await card(alice, saleId).getByRole('button', { name: 'В корзину' }).click();
  await expect(card(bob, saleId).locator('.buy-row')).toContainText('Закончилось');

  // в корзине идёт таймер удержания по серверному expires_at
  await alice.goto('/cart');
  await expect(alice.getByText('Удерживается ещё')).toBeVisible();

  // время вышло: Алисе — уведомление, корзина пуста; Бобу — товар снова доступен
  const deadline = { timeout: (HOLD_TTL_SECONDS + 15) * 1000 };
  await expect(alice.locator('.toast', { hasText: 'Время удержания истекло' })).toBeVisible(deadline);
  await expect(alice.getByText('Корзина пуста')).toBeVisible();
  await expect(card(bob, saleId).getByTestId('available')).toContainText('Осталось 1 из 1');
  await expect(card(bob, saleId).getByRole('button', { name: 'В корзину' })).toBeEnabled();

  // в кабинете Алисы позиция в истории как «удержание истекло»
  await alice.goto('/account');
  await expect(alice.getByText('Удержание истекло')).toBeVisible();

  // и Боб может её купить
  await card(bob, saleId).getByRole('button', { name: 'В корзину' }).click();
  await expect(card(bob, saleId).locator('.buy-row')).toContainText('В корзине');
});
