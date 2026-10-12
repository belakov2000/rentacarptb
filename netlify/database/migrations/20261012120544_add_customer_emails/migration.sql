ALTER TABLE "bookings" ADD COLUMN "start_time" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "end_time" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "pickup_reminder_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "handover_info_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "return_reminder_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "return_soon_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "review_request_at" timestamp;