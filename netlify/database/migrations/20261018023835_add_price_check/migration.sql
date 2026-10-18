ALTER TABLE "bookings" ADD COLUMN "price_check" jsonb;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "price_check_status" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "price_checked_at" timestamp;