CREATE TYPE "public"."active_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."ai_provider" AS ENUM('anthropic', 'openai', 'groq', 'gemini', 'deepseek', 'mistral', 'cohere', 'xai', 'qwen', 'mimo', 'arcee', 'glm', 'minimax', 'kimi', 'bytedance', 'openrouter', 'other');--> statement-breakpoint
CREATE TYPE "public"."assignment_path" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TYPE "public"."attachment_type" AS ENUM('lead', 'campaign');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('active', 'watch', 'critical', 'paused', 'complete');--> statement-breakpoint
CREATE TYPE "public"."change_type" AS ENUM('budget', 'audience', 'creative', 'messaging', 'page');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."connection_method" AS ENUM('api_key', 'oauth', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('processing', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified');--> statement-breakpoint
CREATE TYPE "public"."insight_type" AS ENUM('priority_flag', 'alert', 'win', 'observation', 'insufficient_evidence');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('gohighlevel', 'twenty_crm', 'hubspot', 'salesforce', 'activecampaign', 'mailchimp', 'brevo', 'notifuse', 'meta_ads', 'google_ads', 'slack', 'zapier', 'make', 'tally', 'typeform', 'umami', 'instantly', 'apollo', 'lemlist', 'smartlead', 'systeme_io', 'custom');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'not_connected', 'failed', 'coming_soon');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('not_responded', 'responded');--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('campaign', 'lead', 'meeting');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('starter', 'growth', 'watchtower', 'agency');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('connected', 'not_connected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('surfaced', 'applied', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."serving_state" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('red', 'amber', 'blue', 'green');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('pending_activation', 'active', 'suspended', 'flagged');--> statement-breakpoint
CREATE TYPE "public"."theme" AS ENUM('dark', 'light');--> statement-breakpoint
CREATE TYPE "public"."threshold_unit" AS ENUM('hours', 'days', 'percent', 'currency');--> statement-breakpoint
CREATE TYPE "public"."time_bound_status" AS ENUM('pending', 'met', 'expired');--> statement-breakpoint
CREATE TYPE "public"."webhook_health" AS ENUM('operational', 'stale', 'offline');--> statement-breakpoint
CREATE TYPE "public"."worker_capability" AS ENUM('investigation', 'research', 'campaign_analysis', 'conversation_analysis', 'strategic_analysis', 'evaluation', 'execution');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('completed', 'failed', 'interrupted', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."worker_tier" AS ENUM('utility', 'workhorse', 'deep');--> statement-breakpoint
CREATE TYPE "public"."workload_level" AS ENUM('quick', 'standard', 'deep', 'strategic');--> statement-breakpoint
CREATE TABLE "admin_action_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" varchar(255) NOT NULL,
	"action" varchar(100) NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_worker_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_id" varchar(100) NOT NULL,
	"capability_type" "worker_capability" NOT NULL,
	"objective" text NOT NULL,
	"campaign_id" uuid,
	"tools_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"workload_level" "worker_tier" NOT NULL,
	"model_used" varchar(255) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"byok" boolean DEFAULT false NOT NULL,
	"status" "worker_status" NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"primary_provider" "ai_provider",
	"primary_model_name" varchar(255),
	"primary_api_key_encrypted" text,
	"primary_status" "provider_status" DEFAULT 'not_connected' NOT NULL,
	"fallback_provider" "ai_provider",
	"fallback_model_name" varchar(255),
	"fallback_api_key_encrypted" text,
	"fallback_status" "provider_status" DEFAULT 'not_connected' NOT NULL,
	"fallback_enabled" boolean DEFAULT false NOT NULL,
	"using_fallback" boolean DEFAULT false NOT NULL,
	"refresh_interval_minutes" integer DEFAULT 30 NOT NULL,
	"event_triggers" jsonb DEFAULT '["sla_breach","webhook_silence","lead_batch","budget_threshold"]'::jsonb NOT NULL,
	"last_refresh_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_workload_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_type" varchar(100) NOT NULL,
	"workload_level" "workload_level" NOT NULL,
	"model_used" varchar(255) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"byok" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"change_type" "change_type" NOT NULL,
	"change_description" text NOT NULL,
	"changed_by" uuid NOT NULL,
	"performance_before" jsonb NOT NULL,
	"performance_after" jsonb,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"actor_id" uuid,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid,
	"level" integer NOT NULL,
	"action_text" varchar(500) NOT NULL,
	"why" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"diagnosis" text,
	"expected_outcome" text NOT NULL,
	"risk" text NOT NULL,
	"confidence" "confidence" NOT NULL,
	"next_step" text NOT NULL,
	"why_now" text NOT NULL,
	"memory_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"apply_action" jsonb,
	"status" "recommendation_status" DEFAULT 'surfaced' NOT NULL,
	"surfaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actioned_at" timestamp with time zone,
	"measured_at" timestamp with time zone,
	"outcome_measured" boolean DEFAULT false NOT NULL,
	"outcome_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "campaign_retrospectives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone,
	"total_leads" integer,
	"responded_count" integer,
	"avg_response_time_ms" bigint,
	"acknowledgment_rate" numeric(5, 4),
	"cpl" numeric(12, 2),
	"best_page_id" uuid,
	"worst_page_id" uuid,
	"ai_observation" text,
	"pdf_url" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" "campaign_status" DEFAULT 'active' NOT NULL,
	"owner_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"budget" numeric(12, 2),
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"daily_spend" numeric(12, 2),
	"cpl_threshold" numeric(12, 2),
	"pinned" boolean DEFAULT false NOT NULL,
	"retrospective_ready" boolean DEFAULT false NOT NULL,
	"share_token" uuid,
	"share_link_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"role" "chat_role" NOT NULL,
	"content" text NOT NULL,
	"workload_level" "workload_level",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_tool_sla_breaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"breach_type" varchar(100) NOT NULL,
	"hours_exceeded" integer NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cross_tool_sla_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"rule_type" varchar(100) NOT NULL,
	"threshold_value" integer NOT NULL,
	"threshold_unit" "threshold_unit" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notification_channels" jsonb DEFAULT '["ai_panel"]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid,
	"name" varchar(255) NOT NULL,
	"subdomain" varchar(100) NOT NULL,
	"storage_path" varchar(500) NOT NULL,
	"previous_storage_path" varchar(500),
	"previous_deployed_at" timestamp with time zone,
	"entry_file" varchar(255) DEFAULT 'index.html' NOT NULL,
	"serving_root" varchar(255) DEFAULT '' NOT NULL,
	"status" "deployment_status" DEFAULT 'processing' NOT NULL,
	"storage_size_bytes" bigint DEFAULT 0 NOT NULL,
	"webhook_secret_encrypted" text NOT NULL,
	"early_warning_active" boolean DEFAULT false NOT NULL,
	"early_warning_triggered" boolean DEFAULT false NOT NULL,
	"early_warning_triggered_at" timestamp with time zone,
	"deployed_at" timestamp with time zone,
	"serving_state" "serving_state" DEFAULT 'active' NOT NULL,
	"vip" boolean DEFAULT false NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"domain_name" varchar(255) NOT NULL,
	"verification_token" varchar(255) NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hindsight_retain_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_id" varchar(255) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"entity_id" uuid,
	"campaign_id" uuid,
	"content_summary" varchar(500) NOT NULL,
	"retained_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_label" varchar(255) NOT NULL,
	"url" varchar(500) NOT NULL,
	"secret_encrypted" text NOT NULL,
	"last_received_at" timestamp with time zone,
	"status" "active_status" DEFAULT 'active' NOT NULL,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid,
	"type" "insight_type" NOT NULL,
	"severity" "severity" NOT NULL,
	"observation" text NOT NULL,
	"evidence" text,
	"campaign_tag" varchar(100),
	"reassess_condition" text,
	"reassess_at" timestamp with time zone,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"category" varchar(30),
	"dedupe_key" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"connection_method" "connection_method",
	"api_key_encrypted" text,
	"oauth_access_token_encrypted" text,
	"oauth_refresh_token_encrypted" text,
	"webhook_url" varchar(500),
	"active_modes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "integration_status" DEFAULT 'not_connected' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_assignment_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_assignee_id" uuid,
	"to_assignee_id" uuid NOT NULL,
	"path" "assignment_path" NOT NULL,
	"actioned_by" uuid NOT NULL,
	"actioned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_external_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_contact_id" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_timestamp" timestamp with time zone NOT NULL,
	"event" varchar(500) NOT NULL,
	"source" varchar(100) NOT NULL,
	"is_milestone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deployment_id" uuid,
	"campaign_id" uuid,
	"full_name" varchar(255) NOT NULL,
	"email" varchar(255),
	"phone" varchar(50),
	"source_system" varchar(100) NOT NULL,
	"source_identifier" varchar(255),
	"vip" boolean DEFAULT false NOT NULL,
	"utm_source" varchar(255),
	"utm_medium" varchar(255),
	"utm_campaign" varchar(255),
	"utm_content" varchar(255),
	"utm_term" varchar(255),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "lead_status" DEFAULT 'not_responded' NOT NULL,
	"assignment_path" "assignment_path",
	"assignee_id" uuid,
	"assigned_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"reassigned_at" timestamp with time zone,
	"reassigned_by" uuid,
	"responded_at" timestamp with time zone,
	"responded_by" uuid,
	"has_external_lifecycle_events" boolean DEFAULT false NOT NULL,
	"sla_job_id" varchar(255),
	"sla_alert_sent_at" timestamp with time zone,
	"deployment_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"note_type" "note_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"title" varchar(255),
	"meeting_date" timestamp with time zone,
	"via" varchar(100),
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" varchar(30) NOT NULL,
	"description" text NOT NULL,
	"link" varchar(500),
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_time_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" varchar(30) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"user_id" uuid,
	"lead_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"destination_url" varchar(500) NOT NULL,
	"event_trigger" varchar(100) NOT NULL,
	"secret_encrypted" text,
	"last_sent_at" timestamp with time zone,
	"status" "active_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" varchar(128) NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"path" varchar(700) PRIMARY KEY NOT NULL,
	"content_type" varchar(120) NOT NULL,
	"data_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "super_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(500) NOT NULL,
	"totp_secret_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_note_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_note_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "team_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"attachment_type" "attachment_type",
	"attachment_id" uuid,
	"time_bound_deadline" timestamp with time zone,
	"time_bound_status" time_bound_status,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_token_encrypted" text NOT NULL,
	"bot_username" varchar(100),
	"verified" boolean DEFAULT false NOT NULL,
	"critical_alerts_enabled" boolean DEFAULT true NOT NULL,
	"daily_digest_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_name" varchar(255) NOT NULL,
	"owner_name" varchar(255) NOT NULL,
	"owner_email" varchar(255) NOT NULL,
	"status" "tenant_status" DEFAULT 'pending_activation' NOT NULL,
	"setup_complete" boolean DEFAULT false NOT NULL,
	"has_marketing_stack" boolean,
	"stack_check_completed" boolean DEFAULT false NOT NULL,
	"plan" "plan" DEFAULT 'starter' NOT NULL,
	"monthly_fee_override" numeric(10, 2),
	"polar_customer_id" varchar(255),
	"polar_subscription_id" varchar(255),
	"polar_order_id" varchar(255),
	"logo_url" varchar(500),
	"sla_threshold_minutes" integer DEFAULT 240 NOT NULL,
	"vip_sla_threshold_minutes" integer DEFAULT 60 NOT NULL,
	"vip_lead_enabled" boolean DEFAULT false NOT NULL,
	"daily_summary_time" time DEFAULT '08:00:00' NOT NULL,
	"notification_email" varchar(255) NOT NULL,
	"urgent_alerts_enabled" boolean DEFAULT true NOT NULL,
	"daily_summary_enabled" boolean DEFAULT true NOT NULL,
	"storage_quota_bytes" bigint DEFAULT 5368709120 NOT NULL,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"team_size" varchar(20),
	"notification_prefs" jsonb DEFAULT '{"slaBreach":true,"slaChannel":"both","earlyWarning":true,"budget":true,"webhookOffline":true}'::jsonb NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(500),
	"name" varchar(255) NOT NULL,
	"avatar_url" varchar(500),
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"theme" "theme" DEFAULT 'dark' NOT NULL,
	"invited_by" uuid,
	"invitation_token" varchar(500),
	"invitation_expires_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"telegram_chat_id" varchar(100),
	"notify_enabled" boolean DEFAULT true NOT NULL,
	"notify_channel" varchar(20) DEFAULT 'email' NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"campaign_id" uuid,
	"label" varchar(255) NOT NULL,
	"source_system" varchar(100) NOT NULL,
	"last_received_at" timestamp with time zone,
	"status" "webhook_health" DEFAULT 'operational' NOT NULL,
	"stale_threshold_minutes" integer DEFAULT 480 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_id" uuid,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_worker_logs" ADD CONSTRAINT "agent_worker_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_workload_logs" ADD CONSTRAINT "ai_workload_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_changes" ADD CONSTRAINT "campaign_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_changes" ADD CONSTRAINT "campaign_changes_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_changes" ADD CONSTRAINT "campaign_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_logs" ADD CONSTRAINT "campaign_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_logs" ADD CONSTRAINT "campaign_logs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_logs" ADD CONSTRAINT "campaign_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recommendations" ADD CONSTRAINT "campaign_recommendations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recommendations" ADD CONSTRAINT "campaign_recommendations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_retrospectives" ADD CONSTRAINT "campaign_retrospectives_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_retrospectives" ADD CONSTRAINT "campaign_retrospectives_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_tool_sla_breaches" ADD CONSTRAINT "cross_tool_sla_breaches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_tool_sla_breaches" ADD CONSTRAINT "cross_tool_sla_breaches_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_tool_sla_breaches" ADD CONSTRAINT "cross_tool_sla_breaches_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_tool_sla_breaches" ADD CONSTRAINT "cross_tool_sla_breaches_rule_id_cross_tool_sla_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."cross_tool_sla_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_tool_sla_rules" ADD CONSTRAINT "cross_tool_sla_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_tool_sla_rules" ADD CONSTRAINT "cross_tool_sla_rules_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hindsight_retain_log" ADD CONSTRAINT "hindsight_retain_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_webhooks" ADD CONSTRAINT "inbound_webhooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_webhooks" ADD CONSTRAINT "inbound_webhooks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_from_assignee_id_users_id_fk" FOREIGN KEY ("from_assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_to_assignee_id_users_id_fk" FOREIGN KEY ("to_assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_history" ADD CONSTRAINT "lead_assignment_history_actioned_by_users_id_fk" FOREIGN KEY ("actioned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_external_mappings" ADD CONSTRAINT "lead_external_mappings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_external_mappings" ADD CONSTRAINT "lead_external_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_external_mappings" ADD CONSTRAINT "lead_external_mappings_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_lifecycle_events" ADD CONSTRAINT "lead_lifecycle_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_lifecycle_events" ADD CONSTRAINT "lead_lifecycle_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_reassigned_by_users_id_fk" FOREIGN KEY ("reassigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_responded_by_users_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhooks" ADD CONSTRAINT "outbound_webhooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_visits" ADD CONSTRAINT "page_visits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_visits" ADD CONSTRAINT "page_visits_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_note_recipients" ADD CONSTRAINT "team_note_recipients_team_note_id_team_notes_id_fk" FOREIGN KEY ("team_note_id") REFERENCES "public"."team_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_note_recipients" ADD CONSTRAINT "team_note_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_note_recipients" ADD CONSTRAINT "team_note_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_notes" ADD CONSTRAINT "team_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_notes" ADD CONSTRAINT "team_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_sources" ADD CONSTRAINT "webhook_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_sources" ADD CONSTRAINT "webhook_sources_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_sources" ADD CONSTRAINT "webhook_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_logs" ADD CONSTRAINT "workspace_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_provider_tenant" ON "ai_provider_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_workload_tenant_time" ON "ai_workload_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_campaign_logs_campaign" ON "campaign_logs" USING btree ("campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_recommendations_campaign" ON "campaign_recommendations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_recommendations_status" ON "campaign_recommendations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_retro_campaign" ON "campaign_retrospectives" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_campaigns_tenant" ON "campaigns" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_campaigns_tenant_status" ON "campaigns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_chat_tenant" ON "chat_messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_deployments_subdomain" ON "deployments" USING btree ("subdomain");--> statement-breakpoint
CREATE INDEX "idx_deployments_tenant" ON "deployments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_deployments_campaign" ON "deployments" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_domains_name" ON "domains" USING btree ("domain_name");--> statement-breakpoint
CREATE INDEX "idx_insights_tenant" ON "insights" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_insights_campaign" ON "insights" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_insights_tenant_generated" ON "insights" USING btree ("tenant_id","generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integrations_tenant_provider" ON "integrations" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_lead" ON "lead_lifecycle_events" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_tenant" ON "lead_lifecycle_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_leads_tenant" ON "leads" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_leads_campaign" ON "leads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_leads_deployment" ON "leads" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "idx_leads_status" ON "leads" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_leads_assignee" ON "leads" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_leads_received_at" ON "leads" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_notes_entity" ON "notes" USING btree ("entity_id","note_type");--> statement-breakpoint
CREATE INDEX "idx_notes_tenant" ON "notes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_tenant" ON "notifications" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ott_hash" ON "one_time_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_page_visits_day" ON "page_visits" USING btree ("deployment_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_token" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_super_admins_email" ON "super_admins" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_tnr_note" ON "team_note_recipients" USING btree ("team_note_id");--> statement-breakpoint
CREATE INDEX "idx_tnr_user" ON "team_note_recipients" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_team_notes_tenant" ON "team_notes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_team_notes_attachment" ON "team_notes" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_tenant" ON "telegram_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenants_owner_email" ON "tenants" USING btree ("owner_email");--> statement-breakpoint
CREATE INDEX "idx_users_tenant" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email_tenant" ON "users" USING btree ("email","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_webhook_sources_tenant_deployment" ON "webhook_sources" USING btree ("tenant_id","deployment_id");