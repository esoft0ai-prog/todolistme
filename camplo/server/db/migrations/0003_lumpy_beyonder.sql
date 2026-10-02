ALTER TABLE "integrations" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "secrets_encrypted" text;