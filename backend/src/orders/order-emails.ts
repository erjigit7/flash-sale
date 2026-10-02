/** Тексты писем о заказе. Одно письмо на заказ — о его итоговом статусе. */
export function orderEmail(
  o: { id: string; saleTitle: string; quantity: number; amountCents: number },
  paid: boolean,
): { subject: string; body: string } {
  const amount = (o.amountCents / 100).toLocaleString('ru-RU', { style: 'currency', currency: 'RUB' });
  const short = o.id.slice(0, 8);
  if (paid) {
    return {
      subject: `Заказ ${short} оплачен: ${o.saleTitle}`,
      body: [
        'Спасибо за покупку!',
        '',
        `Товар: ${o.saleTitle}`,
        `Количество: ${o.quantity}`,
        `Сумма: ${amount}`,
        `Номер заказа: ${o.id}`,
        '',
        'Статус заказа всегда виден в личном кабинете.',
      ].join('\n'),
    };
  }
  return {
    subject: `Оплата заказа ${short} не прошла: ${o.saleTitle}`,
    body: [
      'Платёжная система отклонила оплату, деньги не списаны.',
      '',
      `Товар: ${o.saleTitle}`,
      `Количество: ${o.quantity}`,
      `Сумма: ${amount}`,
      `Номер заказа: ${o.id}`,
      '',
      'Товар вернулся на витрину — если распродажа ещё идёт, его можно купить снова.',
    ].join('\n'),
  };
}
