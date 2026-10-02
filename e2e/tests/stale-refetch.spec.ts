import { expect, test } from '@playwright/test';
import { buyerTab, card, createSale, uniqueEmail } from './helpers.ts';

/**
 * Гонка «перезапрос витрины против события остатка»: витрина перезапрашивает список (например, по sale:created),
 * пока запрос в пути — другой покупатель берёт товар и приходит sale:stock с новой версией.
 * Ответ на запрос, ушедший ДО изменения, приходит позже и не должен затереть свежий остаток старым.
 */
test('запоздалый ответ витрины не откатывает остаток, пришедший по событию', async ({ browser }) => {
  const saleId = await createSale({ title: `Гонка кэша ${Date.now()}`, totalQty: 2, startsInSeconds: 0 });
  const alice = await buyerTab(browser, uniqueEmail('buyer'));
  const bob = await buyerTab(browser, uniqueEmail('viewer'));
  await Promise.all([alice.goto('/'), bob.goto('/')]);
  await expect(card(bob, saleId).getByTestId('available')).toContainText('Осталось 2 из 2');

  // следующий запрос витрины у Боба: берём ответ сервера сейчас (остаток 2), а отдаём браузеру через 2 с
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let intercepted!: () => void;
  const wasIntercepted = new Promise<void>((r) => (intercepted = r));
  await bob.route('**/api/sales', async (route) => {
    const stale = await route.fetch();
    intercepted();
    await released;
    await route.fulfill({ response: stale });
  }, { times: 1 });

  // повод перезапросить витрину — магазин выставил новую распродажу (sale:created)
  await createSale({ title: `Повод ${Date.now()}`, totalQty: 1, startsInSeconds: 60 });
  await wasIntercepted;

  // пока ответ «в пути», Алиса берёт товар — Бобу приходит sale:stock с остатком 1
  await card(alice, saleId).getByRole('button', { name: 'В корзину' }).click();
  await expect(card(bob, saleId).getByTestId('available')).toContainText('Осталось 1 из 2');

  // теперь приходит запоздалый ответ с остатком 2 — он не должен откатить витрину назад.
  // Проверка без авто-повтора expect: важно, что откатa нет ни на мгновение, а не что «потом исправится».
  release();
  await bob.waitForTimeout(1000);
  expect(await card(bob, saleId).getByTestId('available').innerText()).toContain('Осталось 1 из 2');
});
