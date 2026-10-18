CREATE TABLE "price_quotes" (
	"id" text PRIMARY KEY,
	"input_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"legs" jsonb NOT NULL,
	"version" text NOT NULL,
	"days" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"deposit_cents" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"booking_id" text,
	"used_at" timestamp,
	CONSTRAINT "price_quotes_total_check" CHECK ("total_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX "price_quotes_expires_idx" ON "price_quotes" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_quotes_booking_idx" ON "price_quotes" ("booking_id");