ALTER TABLE "bookings" ADD COLUMN "car_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "end_date" date;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "payment" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "invoice" text DEFAULT '' NOT NULL;