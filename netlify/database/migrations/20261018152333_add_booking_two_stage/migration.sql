ALTER TABLE "bookings" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "marketing_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "chains" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "second_driver" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "drivers" jsonb;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "first_approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "first_approved_by" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "docs_invited_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "docs_reminder_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "docs_submitted_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "coupon_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "coupon_used_at" timestamp;