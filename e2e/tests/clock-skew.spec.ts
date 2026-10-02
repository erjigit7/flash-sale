import { expect, test } from '@playwright/test';
import { buyerTab, card, createSaleFull, newTabContext, uniqueEmail } from './helpers.ts';

/**
 * «До старта купить нельзя, даже если страница открыта заранее. В момент старта покупка открывается у всех одновременно» —
 * в том числе у покупателя, у которого часы на компьютере сбиты.
 * Часы вкладки уводим на 10 минут вперёд (page.clock): без синхронизации с сервером её кнопка открылась бы сразу.
 */
test('часы покупателя спешат на 10 минут → кнопка всё равно открывается в момент старта по серверу, одновременно со всеми', async ({ browser }) => {
  const SKEW_MS = 10 * 60_000;
  const sale = await createSaleFull({ title: `Часы ${Date.now()}`, totalQty: 1, startsInSeconds: 8 });
  const startsAt = Date.parse(sale.startsAt);

  // вкладка со сбитыми часами: Date.now() в ней на 10 минут впереди, время идёт как обычно
  const skewedContext = await newTabContext(browser);
  await skewedContext.clock.install({ time: Date.now() + SKEW_MS });
  const skewed = await skewedContext.newPage();
  await skewed.goto('/login');
  await skewed.getByLabel('Email').fill(uniqueEmail('skewed'));
  await skewed.getByRole('button', { name: 'Войти' }).click();
  await expect(skewed.getByText('Витрина', { exact: true }).first()).toBeVisible();
  // часы вкладки действительно впереди реального времени процесса теста
  expect((await skewed.evaluate(() => Date.now())) - Date.now()).toBeGreaterThan(SKEW_MS - 60_000);

  const normal = await buyerTab(browser, uniqueEmail('normal'));
  await Promise.all([skewed.goto('/'), normal.goto('/')]);

  // до старта: у «спешащей» вкладки кнопка закрыта и отсчёт — по серверу (секунды, а не «уже началось»)
  const skewedButton = card(skewed, sale.id).locator('.buy-row button');
  await expect(skewedButton).toHaveText(/Старт через 00:0\d/);
  await expect(skewedButton).toBeDisabled();
  // смещение часов вкладки относительно сервера видно в шапке: около −600000 мс
  await expect(skewed.locator('.header-right .num')).toHaveText(/−?-?(59\d|60\d)\d{3} мс/);

  const unlocked = await Promise.all(
    [skewed, normal].map(async (page) => {
      await expect(card(page, sale.id).getByRole('button', { name: 'В корзину' })).toBeEnabled({ timeout: 20_000 });
      return Date.now();
    }),
  );
  // не раньше реального старта и одновременно с нормальной вкладкой
  expect(unlocked[0]).toBeGreaterThanOrEqual(startsAt - 500);
  expect(Math.abs(unlocked[0] - unlocked[1])).toBeLessThan(1500);

  // и покупка проходит
  await card(skewed, sale.id).getByRole('button', { name: 'В корзину' }).click();
  await expect(card(skewed, sale.id).locator('.buy-row')).toContainText('В корзине');
});
