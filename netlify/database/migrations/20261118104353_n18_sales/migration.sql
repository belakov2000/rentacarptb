CREATE TABLE "fiscal_sales" (
	"id" text PRIMARY KEY,
	"booking_id" text NOT NULL,
	"receipt" text UNIQUE,
	"invoice" text UNIQUE,
	"invoice_issued_at" timestamp,
	"snapshot" jsonb NOT NULL,
	"issued_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_series" (
	"id" text PRIMARY KEY,
	"next" bigint NOT NULL,
	"last" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fiscal_sales_booking" ON "fiscal_sales" ("booking_id");--> statement-breakpoint
ALTER TABLE "fiscal_sales" ADD CONSTRAINT "fiscal_sales_id_payments_id_fkey" FOREIGN KEY ("id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "fiscal_sales" ADD CONSTRAINT "fiscal_sales_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id");