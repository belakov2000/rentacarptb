CREATE TABLE "bookings" (
	"id" text PRIMARY KEY,
	"view_token" text NOT NULL,
	"admin_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"lang" text DEFAULT 'bg' NOT NULL,
	"car" text NOT NULL,
	"pickup" text NOT NULL,
	"dropoff" text NOT NULL,
	"total" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
);
