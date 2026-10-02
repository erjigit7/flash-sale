/** HTML-панель заглушки: список платежей, ручное разрешение «зависших», повторная доставка webhook. */
export const panelHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Заглушка оплаты</title>
<style>
  :root { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1d1d1f; background: #f4f4f1; }
  body { margin: 0; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.hint { margin: 0 0 20px; color: #666; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; font-size: 14px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; vertical-align: middle; }
  th { background: #fafafa; font-weight: 600; color: #555; }
  code { font-size: 12px; color: #555; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .processing { background: #fff4d6; color: #8a5a00; }
  .succeeded { background: #dff5e3; color: #17692b; }
  .declined { background: #fde2e2; color: #9b1c1c; }
  .HANG { background: #ececec; color: #444; }
  button { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
  button.ok { border-color: #2e8b47; color: #17692b; }
  button.no { border-color: #c0392b; color: #9b1c1c; }
  .empty { padding: 40px; text-align: center; color: #888; background: #fff; border-radius: 10px; }
  @media (max-width: 700px) { .hide-sm { display: none; } }
</style>
</head>
<body>
<main>
  <h1>Заглушка платёжного провайдера</h1>
  <p class="hint">Сценарии: SUCCESS и DECLINE отвечают webhook'ом через ~1.5 с, HANG «висит», пока вы не решите здесь. Список обновляется сам.</p>
  <div id="root"><div class="empty">Платежей пока нет</div></div>
</main>
<script>
  const statusRu = { processing: 'в обработке', succeeded: 'успешно', declined: 'отклонён' };
  const money = (c) => (c / 100).toLocaleString('ru-RU', { style: 'currency', currency: 'RUB' });
  const time = (s) => s ? new Date(s).toLocaleTimeString('ru-RU') : '—';
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  async function act(id, path, body) {
    await fetch('/payments/' + id + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    load();
  }

  let lastJson = '';
  async function load() {
    const { payments } = await fetch('/payments').then((r) => r.json());
    // перерисовываем только при изменениях, чтобы кнопки не менялись под курсором
    const json = JSON.stringify(payments);
    if (json === lastJson) return;
    lastJson = json;
    const root = document.getElementById('root');
    if (!payments.length) { root.innerHTML = '<div class="empty">Платежей пока нет</div>'; return; }
    root.innerHTML = '<table><thead><tr><th>Платёж</th><th>Сумма</th><th>Сценарий</th><th>Статус</th>' +
      '<th class="hide-sm">Создан</th><th class="hide-sm">Webhook</th><th></th></tr></thead><tbody>' +
      payments.map((p) => '<tr>' +
        '<td><code>' + esc(p.id) + '</code><br><code>заказ ' + esc(p.idempotencyKey.slice(0, 8)) + '…</code></td>' +
        '<td>' + money(p.amountCents) + '</td>' +
        '<td><span class="badge ' + esc(p.scenario) + '">' + esc(p.scenario) + '</span></td>' +
        '<td><span class="badge ' + esc(p.status) + '">' + statusRu[p.status] + '</span></td>' +
        '<td class="hide-sm">' + time(p.createdAt) + '</td>' +
        '<td class="hide-sm">' + (p.webhook.deliveries ? (p.webhook.delivered ? 'доставлен' : 'ошибка: ' + esc(p.webhook.lastStatus)) + ' (×' + p.webhook.deliveries + ')' : '—') + '</td>' +
        '<td>' + (p.status === 'processing'
          ? '<button class="ok" onclick="act(\\'' + p.id + '\\', \\'resolve\\', {result: \\'succeeded\\'})">Подтвердить</button> ' +
            '<button class="no" onclick="act(\\'' + p.id + '\\', \\'resolve\\', {result: \\'declined\\'})">Отклонить</button>'
          : '<button onclick="act(\\'' + p.id + '\\', \\'redeliver\\')" title="Отправить тот же результат ещё раз">Повторить webhook</button>') +
        '</td></tr>').join('') + '</tbody></table>';
  }

  load();
  setInterval(load, 1500);
</script>
</body>
</html>`;
