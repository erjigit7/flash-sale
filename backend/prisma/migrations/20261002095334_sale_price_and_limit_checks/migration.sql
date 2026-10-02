-- Правила формы магазина — и в БД, как последний рубеж (сервис проверяет их раньше и отдаёт понятную ошибку):
-- старая цена, если указана, выше цены распродажи; лимит «в одни руки» не больше партии.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_old_price_above_price" CHECK ("old_price_cents" IS NULL OR "old_price_cents" > "price_cents"),
  ADD CONSTRAINT "sales_max_per_order_within_total" CHECK ("max_per_order" <= "total_qty");
