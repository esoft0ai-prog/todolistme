CREATE TABLE "platform_settings" (
	"section" varchar(40) PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" varchar(255),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_action_log" ALTER COLUMN "target_tenant_id" DROP NOT NULL;