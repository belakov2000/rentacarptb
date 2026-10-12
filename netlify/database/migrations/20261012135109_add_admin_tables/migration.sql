CREATE TABLE "booking_events" (
	"id" serial PRIMARY KEY,
	"booking_id" text,
	"at" timestamp DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"details" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "car_blocks" (
	"id" serial PRIMARY KEY,
	"car_id" text NOT NULL,
	"start_date" date NOT NULL,
	"start_time" text DEFAULT '00:00' NOT NULL,
	"end_date" date NOT NULL,
	"end_time" text DEFAULT '23:59' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"cancelled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cars" (
	"id" text PRIMARY KEY,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"reg" text DEFAULT '' NOT NULL,
	"daily_cents" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_versions" (
	"id" serial PRIMARY KEY,
	"booking_id" text NOT NULL,
	"version" integer NOT NULL,
	"blob_key" text NOT NULL,
	"file_name" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" serial PRIMARY KEY,
	"at" timestamp DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"booking_id" text,
	"recipient" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"dedupe_key" text
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY,
	"car_id" text,
	"date" date NOT NULL,
	"category" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY,
	"booking_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"method" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'expected' NOT NULL,
	"paid_at" timestamp,
	"txn_id" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"refund_of" text,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "total_cents" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "total_review" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "admin_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "updated_at" timestamp;--> statement-breakpoint
CREATE INDEX "booking_events_booking_idx" ON "booking_events" ("booking_id","at");--> statement-breakpoint
CREATE INDEX "bookings_car_dates_idx" ON "bookings" ("car_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" ("status");--> statement-breakpoint
CREATE INDEX "bookings_created_idx" ON "bookings" ("created_at");--> statement-breakpoint
CREATE INDEX "car_blocks_car_idx" ON "car_blocks" ("car_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_versions_booking_version_idx" ON "contract_versions" ("booking_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "email_log_dedupe_idx" ON "email_log" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_log_at_idx" ON "email_log" ("at");--> statement-breakpoint
CREATE INDEX "expenses_date_idx" ON "expenses" ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_key_idx" ON "payments" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" ("booking_id");--> statement-breakpoint
CREATE INDEX "payments_paid_at_idx" ON "payments" ("paid_at");--> statement-breakpoint
ALTER TABLE "car_blocks" ADD CONSTRAINT "car_blocks_car_id_cars_id_fkey" FOREIGN KEY ("car_id") REFERENCES "cars"("id");--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_car_id_cars_id_fkey" FOREIGN KEY ("car_id") REFERENCES "cars"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id");