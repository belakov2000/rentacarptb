ALTER TABLE "bookings" ADD COLUMN "handed_over_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "handed_over_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "closed_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "closed_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "close_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "close_note" text DEFAULT '' NOT NULL;