CREATE TABLE "api_limits" (
	"key" text PRIMARY KEY,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_cache" (
	"key" text PRIMARY KEY,
	"status" text NOT NULL,
	"km" double precision,
	"rate" double precision,
	"local" boolean,
	"source" text,
	"reason" text,
	"claim_token" text,
	"claimed_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_limits_expires_idx" ON "api_limits" ("expires_at");--> statement-breakpoint
CREATE INDEX "route_cache_expires_idx" ON "route_cache" ("expires_at");