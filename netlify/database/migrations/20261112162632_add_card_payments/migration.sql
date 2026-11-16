CREATE TABLE "card_payment_links" (
	"id" text PRIMARY KEY,
	"booking_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"sent_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "card_payments" (
	"id" text PRIMARY KEY,
	"booking_id" text NOT NULL,
	"link_id" text,
	"mode" text NOT NULL,
	"terminal" text NOT NULL,
	"order_no" text NOT NULL,
	"nonce" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"breakdown" jsonb NOT NULL,
	"status" text DEFAULT 'redirected' NOT NULL,
	"action" text,
	"rc" text,
	"status_msg" text,
	"approval" text,
	"rrn" text,
	"int_ref" text,
	"tran_date" text,
	"card_brand" text,
	"result_source" text,
	"duplicate" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"last_check_at" timestamp,
	"checks" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "card_payments_amount_check" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "card_paid_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "card_payment_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "card_payment_links_token_idx" ON "card_payment_links" ("token_hash");--> statement-breakpoint
CREATE INDEX "card_payment_links_booking_idx" ON "card_payment_links" ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_payments_order_idx" ON "card_payments" ("terminal","order_no");--> statement-breakpoint
CREATE INDEX "card_payments_booking_idx" ON "card_payments" ("booking_id");--> statement-breakpoint
CREATE INDEX "card_payments_open_idx" ON "card_payments" ("status","created_at");--> statement-breakpoint
ALTER TABLE "card_payment_links" ADD CONSTRAINT "card_payment_links_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id");--> statement-breakpoint
ALTER TABLE "card_payments" ADD CONSTRAINT "card_payments_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id");