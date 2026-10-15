ALTER TABLE "ad_spend" ADD COLUMN "deleted_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "replaces_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_idempotency_key_idx" ON "ad_spend" ("idempotency_key");--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_amount_check" CHECK ("amount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_period_check" CHECK ("period_start" <= "period_end");--> statement-breakpoint
-- Корекцията сочи към съществуващ запис за разход
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_replaces_id_fkey" FOREIGN KEY ("replaces_id") REFERENCES "ad_spend"("id");--> statement-breakpoint
-- btree_gist е нужно за равенство на текст в EXCLUDE (доверено разширение в PostgreSQL 13+)
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
-- Една кампания и вариант: без два активни записа със застъпващи се периоди (датите са включително) – и при едновременни заявки
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_no_overlap" EXCLUDE USING gist ("campaign" WITH =, "content" WITH =, daterange("period_start", "period_end", '[]') WITH &&) WHERE ("deleted_at" IS NULL);
