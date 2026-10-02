CREATE TABLE "error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"source" varchar(20) NOT NULL,
	"level" varchar(10) DEFAULT 'error' NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"route" varchar(500),
	"tenant_id" uuid,
	"user_id" uuid,
	"context" jsonb,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_error_events_fingerprint" ON "error_events" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "idx_error_events_last_seen" ON "error_events" USING btree ("last_seen_at");