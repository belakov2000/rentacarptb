-- Попълва total_cents (евроцентове) от текстовото поле total, без да го променя.
-- Приема се само точният формат на сайта: „261 €“ или „829,47 €“. Всичко друго се отбелязва за проверка в total_review
-- и total_cents остава празно – стойност не се измисля. Обработват се само още необработени редове, така че е повторяемо.
UPDATE "bookings"
SET "total_cents" = (split_part(substring("total" from '^(\d{1,6})(?:,\d{2})? €$'), ',', 1))::integer * 100
  + COALESCE(NULLIF(substring("total" from '^\d{1,6},(\d{2}) €$'), '')::integer, 0)
WHERE "total_cents" IS NULL AND "total_review" = '' AND "total" ~ '^\d{1,6}(,\d{2})? €$';
--> statement-breakpoint
UPDATE "bookings"
SET "total_review" = CASE WHEN btrim("total") = '' THEN 'empty' ELSE 'unparsed' END
WHERE "total_cents" IS NULL AND "total_review" = '' AND "total" !~ '^\d{1,6}(,\d{2})? €$';
--> statement-breakpoint
-- Автопаркът от сайта и договора (дневната цена е за наем 1–15 дни)
INSERT INTO "cars" ("id", "brand", "model", "reg", "daily_cents", "sort") VALUES
  ('punto', 'Fiat', 'Grande Punto', 'PB7470TE', 2000, 1),
  ('ka', 'Ford', 'Ka', 'PB3083XE', 2000, 2),
  ('ibiza', 'SEAT', 'Ibiza', 'РВ3305УА', 2500, 3),
  ('golf', 'Volkswagen', 'Golf 5', 'РВ1244УА', 2500, 4),
  ('passat', 'Volkswagen', 'Passat', 'РВ8991XE', 2500, 5)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES
  ('buffer_minutes', '60'),
  ('notifications', '{"newBooking":true,"pendingReminder":true,"decision":true,"upcomingPickup":true,"upcomingReturn":true,"unpaidBalance":true,"paymentRecorded":true,"refund":true,"emailFailure":true}'),
  ('reports', '{"weekly":false,"monthly":false}')
ON CONFLICT ("key") DO NOTHING;
