ALTER TABLE "bookings" ADD COLUMN "decided_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "decision_note" text DEFAULT '' NOT NULL;