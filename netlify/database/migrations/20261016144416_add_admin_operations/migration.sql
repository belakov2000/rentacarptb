CREATE TABLE "booking_extensions" (
	"id" serial PRIMARY KEY,
	"booking_id" text NOT NULL,
	"old_end_date" date NOT NULL,
	"old_end_time" text NOT NULL,
	"new_end_date" date NOT NULL,
	"new_end_time" text NOT NULL,
	"old_total_cents" integer,
	"new_total_cents" integer,
	"added_cents" integer NOT NULL,
	"daily_cents" integer,
	"added_days" integer,
	"calc" text NOT NULL,
	"contract_version" integer,
	"notify" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "returned_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "returned_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "return_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "customer_id" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "documents" jsonb;--> statement-breakpoint
ALTER TABLE "car_blocks" ADD COLUMN "kind" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "car_blocks" ADD COLUMN "cancelled_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "car_blocks" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "cars" ADD COLUMN "inspection_due" date;--> statement-breakpoint
ALTER TABLE "cars" ADD COLUMN "insurance_due" date;--> statement-breakpoint
ALTER TABLE "cars" ADD COLUMN "service_due" date;--> statement-breakpoint
ALTER TABLE "cars" ADD COLUMN "updated_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cars" ADD COLUMN "updated_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_extensions_key_idx" ON "booking_extensions" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "booking_extensions_booking_idx" ON "booking_extensions" ("booking_id");--> statement-breakpoint
CREATE INDEX "bookings_customer_idx" ON "bookings" ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "car_blocks_key_idx" ON "car_blocks" ("idempotency_key");--> statement-breakpoint
ALTER TABLE "booking_extensions" ADD CONSTRAINT "booking_extensions_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id");