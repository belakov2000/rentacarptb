ALTER TABLE "bookings" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "next_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_request_key_idx" ON "bookings" ("request_key");--> statement-breakpoint
CREATE INDEX "email_log_retry_idx" ON "email_log" ("status","next_attempt_at");