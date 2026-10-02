import { expect, test } from '@playwright/test';
import { buyerTab, card, shopTab, uniqueEmail } from './helpers.ts';

/**
 * Баг, найденный заказчиком: новая распродажа не появлялась на открытой витрине без F5.
 * Магазин создаёт распродажу через свою форму — у покупателя карточка появляется сама, с отсчётом до старта.
 */
test('магазин выставил распродажу → у покупателя с открытой витриной карточка появляется без перезагрузки', async ({ browser }) => {
  const buyer = await buyerTab(browser, uniqueEmail('watcher'));
  await buyer.goto('/');
  await expect(buyer.getByRole('heading', { name: 'Витрина' })).toBeVisible();

  const shop = await shopTab(browser);
  const title = `Новинка ${Date.now()}`;
  await shop.getByLabel('Товар').fill(title);
  await shop.getByRole('button', { name: 'Выставить на распродажу' }).click();

  // никакой перезагрузки у покупателя — карточка приходит по sale:created
  const newCard = buyer.locator('article.sale', { hasText: title });
  await expect(newCard).toBeVisible();
  await expect(newCard.locator('.buy-row button')).toHaveText(/Старт через/);

  // и она «живая»: дальше остаток/старт обновляются как у остальных
  const saleId = (await newCard.getAttribute('data-testid'))!.replace('sale-', '');
  await expect(card(buyer, saleId).getByTestId('available')).toContainText('Осталось 1 из 1');
});
