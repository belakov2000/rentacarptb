CREATE TABLE "ad_spend" (
	"id" serial PRIMARY KEY,
	"campaign" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "utm_source" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "utm_medium" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "utm_content" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "utm_term" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "utm_at" timestamp;--> statement-breakpoint
CREATE INDEX "ad_spend_campaign_idx" ON "ad_spend" ("campaign","content","period_start");--> statement-breakpoint
CREATE INDEX "bookings_utm_idx" ON "bookings" ("utm_campaign","utm_content");