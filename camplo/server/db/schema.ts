/**
 * Camplo schema — mirrors "Camplo — Authoritative Data Model v1.0" (31 tables).
 * Additions that the data model does not list are grouped at the bottom under
 * "PROPOSED ADDITIONS" and documented in README.md; they are required by
 * endpoints in the Build Spec (sessions, notifications, reset/ack tokens…).
 *
 * Conventions: UUID PKs, tenant_id on every tenant-owned table, UTC timestamps,
 * lowercase snake_case enums, `_encrypted` suffix = AES-256-GCM ciphertext.
 */
import {
  pgTable, pgEnum, uuid, varchar, text, boolean, integer, bigint, timestamp, date, time,
  numeric, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });

// ---------- enums ----------
export const tenantStatus = pgEnum('tenant_status', ['pending_activation', 'active', 'suspended', 'flagged']);
export const planEnum = pgEnum('plan', ['starter', 'growth', 'watchtower', 'agency']);
export const roleEnum = pgEnum('user_role', ['owner', 'admin', 'member']);
export const themeEnum = pgEnum('theme', ['dark', 'light']);
export const campaignStatus = pgEnum('campaign_status', ['active', 'watch', 'critical', 'paused', 'complete']);
export const recStatus = pgEnum('recommendation_status', ['surfaced', 'applied', 'dismissed']);
export const confidenceEnum = pgEnum('confidence', ['low', 'medium', 'high']);
export const changeType = pgEnum('change_type', ['budget', 'audience', 'creative', 'messaging', 'page']);
export const deploymentStatus = pgEnum('deployment_status', ['processing', 'ready', 'failed', 'deleted']);
export const domainStatus = pgEnum('domain_status', ['pending', 'verified']);
export const webhookHealth = pgEnum('webhook_health', ['operational', 'stale', 'offline']);
export const leadStatus = pgEnum('lead_status', ['not_responded', 'responded']);
export const assignmentPath = pgEnum('assignment_path', ['A', 'B', 'C']);
export const noteType = pgEnum('note_type', ['campaign', 'lead', 'meeting']);
export const attachmentType = pgEnum('attachment_type', ['lead', 'campaign']);
export const timeBoundStatus = pgEnum('time_bound_status', ['pending', 'met', 'expired']);
export const insightType = pgEnum('insight_type', ['priority_flag', 'alert', 'win', 'observation', 'insufficient_evidence']);
export const severityEnum = pgEnum('severity', ['red', 'amber', 'blue', 'green']);
export const integrationProvider = pgEnum('integration_provider', [
  'gohighlevel', 'twenty_crm', 'hubspot', 'salesforce', 'activecampaign', 'mailchimp', 'brevo', 'notifuse',
  'meta_ads', 'google_ads', 'slack', 'zapier', 'make', 'tally', 'typeform', 'umami', 'instantly', 'apollo',
  'lemlist', 'smartlead', 'systeme_io', 'custom',
]);
export const connectionMethod = pgEnum('connection_method', ['api_key', 'oauth', 'webhook']);
export const integrationStatus = pgEnum('integration_status', ['connected', 'not_connected', 'failed', 'coming_soon']);
export const thresholdUnit = pgEnum('threshold_unit', ['hours', 'days', 'percent', 'currency']);
export const aiProvider = pgEnum('ai_provider', [
  'anthropic', 'openai', 'groq', 'gemini', 'deepseek', 'mistral', 'cohere', 'xai', 'qwen', 'mimo', 'arcee',
  'glm', 'minimax', 'kimi', 'bytedance', 'openrouter', 'other',
]);
export const providerStatus = pgEnum('provider_status', ['connected', 'not_connected', 'failed']);
export const workloadLevel = pgEnum('workload_level', ['quick', 'standard', 'deep', 'strategic']);
export const activeStatus = pgEnum('active_status', ['active', 'inactive']);
export const chatRole = pgEnum('chat_role', ['user', 'assistant']);
export const workerCapability = pgEnum('worker_capability', [
  'investigation', 'research', 'campaign_analysis', 'conversation_analysis', 'strategic_analysis', 'evaluation', 'execution',
]);
export const workerTier = pgEnum('worker_tier', ['utility', 'workhorse', 'deep']);
export const workerStatus = pgEnum('worker_status', ['completed', 'failed', 'interrupted', 'timeout']);
export const servingState = pgEnum('serving_state', ['active', 'paused', 'archived']);

export type NotificationPrefs = { slaBreach: boolean; slaChannel: 'email' | 'telegram' | 'both'; earlyWarning: boolean; budget: boolean; webhookOffline: boolean };

// ---------- 1. tenants ----------
export const tenants = pgTable('tenants', {
  id: id(),
  businessName: varchar('business_name', { length: 255 }).notNull(),
  ownerName: varchar('owner_name', { length: 255 }).notNull(),
  ownerEmail: varchar('owner_email', { length: 255 }).notNull(),
  status: tenantStatus('status').notNull().default('pending_activation'),
  setupComplete: boolean('setup_complete').notNull().default(false),
  hasMarketingStack: boolean('has_marketing_stack'),
  stackCheckCompleted: boolean('stack_check_completed').notNull().default(false),
  plan: planEnum('plan').notNull().default('starter'),
  monthlyFeeOverride: numeric('monthly_fee_override', { precision: 10, scale: 2 }),
  polarCustomerId: varchar('polar_customer_id', { length: 255 }),
  polarSubscriptionId: varchar('polar_subscription_id', { length: 255 }),
  polarOrderId: varchar('polar_order_id', { length: 255 }),
  logoUrl: varchar('logo_url', { length: 500 }),
  slaThresholdMinutes: integer('sla_threshold_minutes').notNull().default(240),
  vipSlaThresholdMinutes: integer('vip_sla_threshold_minutes').notNull().default(60),
  vipLeadEnabled: boolean('vip_lead_enabled').notNull().default(false),
  dailySummaryTime: time('daily_summary_time').notNull().default('08:00:00'),
  notificationEmail: varchar('notification_email', { length: 255 }).notNull(),
  urgentAlertsEnabled: boolean('urgent_alerts_enabled').notNull().default(true),
  dailySummaryEnabled: boolean('daily_summary_enabled').notNull().default(true),
  storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' }).notNull().default(5368709120),
  storageUsedBytes: bigint('storage_used_bytes', { mode: 'number' }).notNull().default(0),
  // proposed: onboarding team size (A5) + suspension timestamp (7-day page grace)
  teamSize: varchar('team_size', { length: 20 }),
  notificationPrefs: jsonb('notification_prefs').$type<NotificationPrefs>().notNull().default({ slaBreach: true, slaChannel: 'both', earlyWarning: true, budget: true, webhookOffline: true }),
  suspendedAt: ts('suspended_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  activatedAt: ts('activated_at'),
}, (t) => [uniqueIndex('idx_tenants_owner_email').on(t.ownerEmail)]);

// ---------- 2. users ----------
export const users = pgTable('users', {
  id: id(),
  tenantId: tenantId(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 500 }),
  name: varchar('name', { length: 255 }).notNull(),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  role: roleEnum('role').notNull().default('member'),
  theme: themeEnum('theme').notNull().default('dark'),
  invitedBy: uuid('invited_by'),
  invitationToken: varchar('invitation_token', { length: 500 }),
  invitationExpiresAt: ts('invitation_expires_at'),
  joinedAt: ts('joined_at'),
  lastActiveAt: ts('last_active_at'),
  telegramChatId: varchar('telegram_chat_id', { length: 100 }),
  // proposed: per-member notification rules (SLA config → Notification Rules)
  notifyEnabled: boolean('notify_enabled').notNull().default(true),
  notifyChannel: varchar('notify_channel', { length: 20 }).notNull().default('email'),
  removedAt: ts('removed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('idx_users_tenant').on(t.tenantId), uniqueIndex('idx_users_email_tenant').on(t.email, t.tenantId)]);

// ---------- 3. campaigns ----------
export const campaigns = pgTable('campaigns', {
  id: id(),
  tenantId: tenantId(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: campaignStatus('status').notNull().default('active'),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  startDate: date('start_date').notNull(),
  budget: numeric('budget', { precision: 12, scale: 2 }),
  currency: varchar('currency', { length: 10 }).notNull().default('USD'),
  dailySpend: numeric('daily_spend', { precision: 12, scale: 2 }),
  cplThreshold: numeric('cpl_threshold', { precision: 12, scale: 2 }),
  pinned: boolean('pinned').notNull().default(false),
  retrospectiveReady: boolean('retrospective_ready').notNull().default(false),
  shareToken: uuid('share_token'),
  shareLinkActive: boolean('share_link_active').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
}, (t) => [index('idx_campaigns_tenant').on(t.tenantId), index('idx_campaigns_tenant_status').on(t.tenantId, t.status)]);

// ---------- 4. campaign_members ----------
export const campaignMembers = pgTable('campaign_members', {
  id: id(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id),
  addedAt: ts('added_at').notNull().defaultNow(),
});

// ---------- 5. campaign_logs ----------
export const campaignLogs = pgTable('campaign_logs', {
  id: id(),
  tenantId: tenantId(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => users.id), // null = Camplo system actor
  description: text('description').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('idx_campaign_logs_campaign').on(t.campaignId, t.createdAt)]);

// ---------- 6. campaign_retrospectives ----------
export const campaignRetrospectives = pgTable('campaign_retrospectives', {
  id: id(),
  tenantId: tenantId(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  generated: boolean('generated').notNull().default(false),
  generatedAt: ts('generated_at'),
  totalLeads: integer('total_leads'),
  respondedCount: integer('responded_count'),
  avgResponseTimeMs: bigint('avg_response_time_ms', { mode: 'number' }),
  acknowledgmentRate: numeric('acknowledgment_rate', { precision: 5, scale: 4 }),
  cpl: numeric('cpl', { precision: 12, scale: 2 }),
  bestPageId: uuid('best_page_id'),
  worstPageId: uuid('worst_page_id'),
  aiObservation: text('ai_observation'),
  pdfUrl: varchar('pdf_url', { length: 500 }),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_retro_campaign').on(t.campaignId)]);

// ---------- 7. campaign_recommendations ----------
export type EvidenceItem = { metric: string; change: string; period: string };
export type ApplyAction = { type: string; platform: string; campaign_external_id?: string; adjustment?: string; status: 'pending_v2' | 'applied' };
export const campaignRecommendations = pgTable('campaign_recommendations', {
  id: id(),
  tenantId: tenantId(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  level: integer('level').notNull(),
  actionText: varchar('action_text', { length: 500 }).notNull(),
  why: text('why').notNull(),
  evidence: jsonb('evidence').$type<EvidenceItem[]>().notNull(),
  diagnosis: text('diagnosis'),
  expectedOutcome: text('expected_outcome').notNull(),
  risk: text('risk').notNull(),
  confidence: confidenceEnum('confidence').notNull(),
  nextStep: text('next_step').notNull(),
  whyNow: text('why_now').notNull(),
  memoryReferences: jsonb('memory_references').$type<string[]>().notNull().default([]),
  applyAction: jsonb('apply_action').$type<ApplyAction | null>(),
  status: recStatus('status').notNull().default('surfaced'),
  surfacedAt: ts('surfaced_at').notNull().defaultNow(),
  actionedAt: ts('actioned_at'),
  measuredAt: ts('measured_at'),
  outcomeMeasured: boolean('outcome_measured').notNull().default(false),
  outcomeData: jsonb('outcome_data'),
}, (t) => [index('idx_recommendations_campaign').on(t.campaignId), index('idx_recommendations_status').on(t.tenantId, t.status)]);

// ---------- 8. campaign_changes ----------
export type PerfSnapshot = { lead_count_7d: number; avg_response_ms: number | null; acknowledgment_rate: number | null; cpl: number | null; conversion_rate: number | null };
export const campaignChanges = pgTable('campaign_changes', {
  id: id(),
  tenantId: tenantId(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  changeType: changeType('change_type').notNull(),
  changeDescription: text('change_description').notNull(),
  changedBy: uuid('changed_by').notNull().references(() => users.id),
  performanceBefore: jsonb('performance_before').$type<PerfSnapshot>().notNull(),
  performanceAfter: jsonb('performance_after').$type<PerfSnapshot | null>(),
  changedAt: ts('changed_at').notNull().defaultNow(),
});

// ---------- 9. deployments ----------
export const deployments = pgTable('deployments', {
  id: id(),
  tenantId: tenantId(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 255 }).notNull(),
  subdomain: varchar('subdomain', { length: 100 }).notNull(),
  storagePath: varchar('storage_path', { length: 500 }).notNull(),
  previousStoragePath: varchar('previous_storage_path', { length: 500 }),
  previousDeployedAt: ts('previous_deployed_at'),
  entryFile: varchar('entry_file', { length: 255 }).notNull().default('index.html'),
  servingRoot: varchar('serving_root', { length: 255 }).notNull().default(''),
  status: deploymentStatus('status').notNull().default('processing'),
  storageSizeBytes: bigint('storage_size_bytes', { mode: 'number' }).notNull().default(0),
  webhookSecretEncrypted: text('webhook_secret_encrypted').notNull(),
  earlyWarningActive: boolean('early_warning_active').notNull().default(false),
  earlyWarningTriggered: boolean('early_warning_triggered').notNull().default(false),
  earlyWarningTriggeredAt: ts('early_warning_triggered_at'),
  deployedAt: ts('deployed_at'),
  // proposed: pause/unpause/archive (Pages actions) and VIP page rule (SLA config)
  servingState: servingState('serving_state').notNull().default('active'),
  vip: boolean('vip').notNull().default(false),
  failureReason: text('failure_reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_deployments_subdomain').on(t.subdomain), index('idx_deployments_tenant').on(t.tenantId), index('idx_deployments_campaign').on(t.campaignId)]);

// ---------- 10. domains ----------
export const domains = pgTable('domains', {
  id: id(),
  tenantId: tenantId(),
  deploymentId: uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
  domainName: varchar('domain_name', { length: 255 }).notNull(),
  verificationToken: varchar('verification_token', { length: 255 }).notNull(),
  status: domainStatus('status').notNull().default('pending'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_domains_name').on(t.domainName)]);

// ---------- 11. webhook_sources ----------
export const webhookSources = pgTable('webhook_sources', {
  id: id(),
  tenantId: tenantId(),
  deploymentId: uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  label: varchar('label', { length: 255 }).notNull(),
  sourceSystem: varchar('source_system', { length: 100 }).notNull(),
  lastReceivedAt: ts('last_received_at'),
  status: webhookHealth('status').notNull().default('operational'),
  staleThresholdMinutes: integer('stale_threshold_minutes').notNull().default(480),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_webhook_sources_tenant_deployment').on(t.tenantId, t.deploymentId)]);

// ---------- 12. leads ----------
export const leads = pgTable('leads', {
  id: id(),
  tenantId: tenantId(),
  deploymentId: uuid('deployment_id').references(() => deployments.id, { onDelete: 'set null' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  sourceSystem: varchar('source_system', { length: 100 }).notNull(),
  sourceIdentifier: varchar('source_identifier', { length: 255 }),
  vip: boolean('vip').notNull().default(false),
  utmSource: varchar('utm_source', { length: 255 }),
  utmMedium: varchar('utm_medium', { length: 255 }),
  utmCampaign: varchar('utm_campaign', { length: 255 }),
  utmContent: varchar('utm_content', { length: 255 }),
  utmTerm: varchar('utm_term', { length: 255 }),
  receivedAt: ts('received_at').notNull().defaultNow(), // Timer 1 anchor — never changes
  status: leadStatus('status').notNull().default('not_responded'),
  assignmentPath: assignmentPath('assignment_path'),
  assigneeId: uuid('assignee_id').references(() => users.id),
  assignedAt: ts('assigned_at'),
  claimedAt: ts('claimed_at'),
  reassignedAt: ts('reassigned_at'),
  reassignedBy: uuid('reassigned_by').references(() => users.id),
  respondedAt: ts('responded_at'), // both timers freeze here — irreversible
  respondedBy: uuid('responded_by').references(() => users.id),
  hasExternalLifecycleEvents: boolean('has_external_lifecycle_events').notNull().default(false),
  slaJobId: varchar('sla_job_id', { length: 255 }),
  slaAlertSentAt: ts('sla_alert_sent_at'), // proposed: idempotent cron-based breach alerts
  deploymentDeleted: boolean('deployment_deleted').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  index('idx_leads_tenant').on(t.tenantId), index('idx_leads_campaign').on(t.campaignId), index('idx_leads_deployment').on(t.deploymentId),
  index('idx_leads_status').on(t.tenantId, t.status), index('idx_leads_assignee').on(t.assigneeId), index('idx_leads_received_at').on(t.tenantId, t.receivedAt),
]);

// ---------- 13. lead_assignment_history ----------
export const leadAssignmentHistory = pgTable('lead_assignment_history', {
  id: id(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  fromAssigneeId: uuid('from_assignee_id').references(() => users.id),
  toAssigneeId: uuid('to_assignee_id').notNull().references(() => users.id),
  path: assignmentPath('path').notNull(),
  actionedBy: uuid('actioned_by').notNull().references(() => users.id),
  actionedAt: ts('actioned_at').notNull().defaultNow(),
});

// ---------- 14. lead_lifecycle_events ----------
export const leadLifecycleEvents = pgTable('lead_lifecycle_events', {
  id: id(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  eventTimestamp: ts('event_timestamp').notNull(),
  event: varchar('event', { length: 500 }).notNull(),
  source: varchar('source', { length: 100 }).notNull(),
  isMilestone: boolean('is_milestone').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('idx_lifecycle_lead').on(t.leadId), index('idx_lifecycle_tenant').on(t.tenantId)]);

// ---------- 15. lead_external_mappings ----------
export const leadExternalMappings = pgTable('lead_external_mappings', {
  id: id(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  integrationId: uuid('integration_id').notNull().references(() => integrations.id, { onDelete: 'cascade' }),
  externalContactId: varchar('external_contact_id', { length: 500 }).notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---------- 16. notes ----------
export const notes = pgTable('notes', {
  id: id(),
  tenantId: tenantId(),
  noteType: noteType('note_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  authorId: uuid('author_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  // proposed: meeting-note metadata (Screen 26 manual compose)
  title: varchar('title', { length: 255 }),
  meetingDate: ts('meeting_date'),
  via: varchar('via', { length: 100 }),
  editedAt: ts('edited_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('idx_notes_entity').on(t.entityId, t.noteType), index('idx_notes_tenant').on(t.tenantId)]);

// ---------- 17. team_notes ----------
export const teamNotes = pgTable('team_notes', {
  id: id(),
  tenantId: tenantId(),
  authorId: uuid('author_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  attachmentType: attachmentType('attachment_type'),
  attachmentId: uuid('attachment_id'),
  timeBoundDeadline: ts('time_bound_deadline'),
  timeBoundStatus: timeBoundStatus('time_bound_status'),
  editedAt: ts('edited_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('idx_team_notes_tenant').on(t.tenantId), index('idx_team_notes_attachment').on(t.attachmentId)]);

// ---------- 18. team_note_recipients ----------
export const teamNoteRecipients = pgTable('team_note_recipients', {
  id: id(),
  teamNoteId: uuid('team_note_id').notNull().references(() => teamNotes.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id),
  readAt: ts('read_at'),
  acknowledgedAt: ts('acknowledged_at'),
}, (t) => [index('idx_tnr_note').on(t.teamNoteId), index('idx_tnr_user').on(t.userId, t.tenantId)]);

// ---------- 19. insights ----------
export const insights = pgTable('insights', {
  id: id(),
  tenantId: tenantId(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  type: insightType('type').notNull(),
  severity: severityEnum('severity').notNull(),
  observation: text('observation').notNull(),
  evidence: text('evidence'),
  campaignTag: varchar('campaign_tag', { length: 100 }),
  reassessCondition: text('reassess_condition'),
  reassessAt: ts('reassess_at'),
  generatedAt: ts('generated_at').notNull().defaultNow(),
  dismissedAt: ts('dismissed_at'),
  // proposed: filter-pill category + de-duplication key for rule-generated cards
  category: varchar('category', { length: 30 }),
  dedupeKey: varchar('dedupe_key', { length: 255 }),
}, (t) => [index('idx_insights_tenant').on(t.tenantId), index('idx_insights_campaign').on(t.campaignId), index('idx_insights_tenant_generated').on(t.tenantId, t.generatedAt)]);

// ---------- 20. integrations ----------
export const integrations = pgTable('integrations', {
  id: id(),
  tenantId: tenantId(),
  provider: integrationProvider('provider').notNull(),
  connectionMethod: connectionMethod('connection_method'),
  apiKeyEncrypted: text('api_key_encrypted'),
  oauthAccessTokenEncrypted: text('oauth_access_token_encrypted'),
  oauthRefreshTokenEncrypted: text('oauth_refresh_token_encrypted'),
  webhookUrl: varchar('webhook_url', { length: 500 }),
  activeModes: jsonb('active_modes').$type<Array<'receive' | 'send' | 'query'>>().notNull().default([]),
  status: integrationStatus('status').notNull().default('not_connected'),
  lastVerifiedAt: ts('last_verified_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_integrations_tenant_provider').on(t.tenantId, t.provider)]);

// ---------- 21. cross_tool_sla_rules ----------
export const crossToolSlaRules = pgTable('cross_tool_sla_rules', {
  id: id(),
  tenantId: tenantId(),
  integrationId: uuid('integration_id').notNull().references(() => integrations.id, { onDelete: 'cascade' }),
  ruleType: varchar('rule_type', { length: 100 }).notNull(),
  thresholdValue: integer('threshold_value').notNull(),
  thresholdUnit: thresholdUnit('threshold_unit').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  notificationChannels: jsonb('notification_channels').$type<Array<'ai_panel' | 'email' | 'telegram'>>().notNull().default(['ai_panel']),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ---------- 22. cross_tool_sla_breaches ----------
export const crossToolSlaBreaches = pgTable('cross_tool_sla_breaches', {
  id: id(),
  tenantId: tenantId(),
  leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  integrationId: uuid('integration_id').notNull().references(() => integrations.id, { onDelete: 'cascade' }),
  ruleId: uuid('rule_id').notNull().references(() => crossToolSlaRules.id, { onDelete: 'cascade' }),
  breachType: varchar('breach_type', { length: 100 }).notNull(),
  hoursExceeded: integer('hours_exceeded').notNull(),
  resolved: boolean('resolved').notNull().default(false),
  detectedAt: ts('detected_at').notNull().defaultNow(),
  resolvedAt: ts('resolved_at'),
});

// ---------- 23. ai_provider_configs ----------
export const aiProviderConfigs = pgTable('ai_provider_configs', {
  id: id(),
  tenantId: tenantId(),
  primaryProvider: aiProvider('primary_provider'),
  primaryModelName: varchar('primary_model_name', { length: 255 }),
  primaryApiKeyEncrypted: text('primary_api_key_encrypted'),
  primaryStatus: providerStatus('primary_status').notNull().default('not_connected'),
  fallbackProvider: aiProvider('fallback_provider'),
  fallbackModelName: varchar('fallback_model_name', { length: 255 }),
  fallbackApiKeyEncrypted: text('fallback_api_key_encrypted'),
  fallbackStatus: providerStatus('fallback_status').notNull().default('not_connected'),
  fallbackEnabled: boolean('fallback_enabled').notNull().default(false),
  usingFallback: boolean('using_fallback').notNull().default(false),
  refreshIntervalMinutes: integer('refresh_interval_minutes').notNull().default(30),
  eventTriggers: jsonb('event_triggers').$type<string[]>().notNull().default(['sla_breach', 'webhook_silence', 'lead_batch', 'budget_threshold']),
  lastRefreshAt: ts('last_refresh_at'), // proposed: 15-min manual refresh debounce + schedule
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_ai_provider_tenant').on(t.tenantId)]);

// ---------- 24. ai_workload_logs ----------
export const aiWorkloadLogs = pgTable('ai_workload_logs', {
  id: id(),
  tenantId: tenantId(),
  taskType: varchar('task_type', { length: 100 }).notNull(),
  workloadLevel: workloadLevel('workload_level').notNull(),
  modelUsed: varchar('model_used', { length: 255 }).notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  byok: boolean('byok').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('idx_workload_tenant_time').on(t.tenantId, t.createdAt)]);

// ---------- 25. telegram_connections ----------
export const telegramConnections = pgTable('telegram_connections', {
  id: id(),
  tenantId: tenantId(),
  botTokenEncrypted: text('bot_token_encrypted').notNull(),
  botUsername: varchar('bot_username', { length: 100 }),
  verified: boolean('verified').notNull().default(false),
  criticalAlertsEnabled: boolean('critical_alerts_enabled').notNull().default(true),
  dailyDigestEnabled: boolean('daily_digest_enabled').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_telegram_tenant').on(t.tenantId)]);

// ---------- 26. inbound_webhooks ----------
export const inboundWebhooks = pgTable('inbound_webhooks', {
  id: id(),
  tenantId: tenantId(),
  sourceLabel: varchar('source_label', { length: 255 }).notNull(),
  url: varchar('url', { length: 500 }).notNull(),
  secretEncrypted: text('secret_encrypted').notNull(),
  lastReceivedAt: ts('last_received_at'),
  status: activeStatus('status').notNull().default('active'),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }), // proposed: per-source attribution (§17.6)
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---------- 27. outbound_webhooks ----------
export const outboundWebhooks = pgTable('outbound_webhooks', {
  id: id(),
  tenantId: tenantId(),
  destinationUrl: varchar('destination_url', { length: 500 }).notNull(),
  eventTrigger: varchar('event_trigger', { length: 100 }).notNull(),
  secretEncrypted: text('secret_encrypted'),
  lastSentAt: ts('last_sent_at'),
  status: activeStatus('status').notNull().default('active'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---------- 28. chat_messages ----------
export const chatMessages = pgTable('chat_messages', {
  id: id(),
  tenantId: tenantId(),
  userId: uuid('user_id').references(() => users.id),
  role: chatRole('role').notNull(),
  content: text('content').notNull(),
  workloadLevel: workloadLevel('workload_level'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('idx_chat_tenant').on(t.tenantId, t.createdAt)]);

// ---------- 29. admin_action_log ----------
export const adminActionLog = pgTable('admin_action_log', {
  id: id(),
  adminId: varchar('admin_id', { length: 255 }).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  targetTenantId: uuid('target_tenant_id'), // null = platform-wide change (Super Admin settings)
  note: text('note'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---------- 30. agent_worker_logs ----------
export const agentWorkerLogs = pgTable('agent_worker_logs', {
  id: id(),
  tenantId: tenantId(),
  workerId: varchar('worker_id', { length: 100 }).notNull(),
  capabilityType: workerCapability('capability_type').notNull(),
  objective: text('objective').notNull(),
  campaignId: uuid('campaign_id'),
  toolsUsed: jsonb('tools_used').$type<string[]>().notNull().default([]),
  toolCallCount: integer('tool_call_count').notNull().default(0),
  workloadLevel: workerTier('workload_level').notNull(),
  modelUsed: varchar('model_used', { length: 255 }).notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  byok: boolean('byok').notNull().default(false),
  status: workerStatus('status').notNull(),
  durationMs: integer('duration_ms').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
});

// ---------- 31. hindsight_retain_log ----------
export const hindsightRetainLog = pgTable('hindsight_retain_log', {
  id: id(),
  tenantId: tenantId(),
  bankId: varchar('bank_id', { length: 255 }).notNull(),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  entityId: uuid('entity_id'),
  campaignId: uuid('campaign_id'),
  contentSummary: varchar('content_summary', { length: 500 }).notNull(),
  retainedAt: ts('retained_at').notNull().defaultNow(),
});

// =====================================================================
// PROPOSED ADDITIONS — needed by Build Spec endpoints, not in Data Model
// =====================================================================

/** Refresh-token sessions (POST /auth/refresh, 7-day inactivity expiry). */
export const sessions = pgTable('sessions', {
  id: id(),
  tenantId: tenantId(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenHash: varchar('refresh_token_hash', { length: 128 }).notNull(),
  lastUsedAt: ts('last_used_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_sessions_token').on(t.refreshTokenHash)]);

/** Single-use tokens: password reset + lead acknowledgment magic links. */
export const oneTimeTokens = pgTable('one_time_tokens', {
  id: id(),
  tenantId: tenantId(),
  purpose: varchar('purpose', { length: 30 }).notNull(), // 'password_reset' | 'acknowledge' | 'magic_login'
  tokenHash: varchar('token_hash', { length: 128 }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_ott_hash').on(t.tokenHash)]);

/** O7 notification panel. */
export const notifications = pgTable('notifications', {
  id: id(),
  tenantId: tenantId(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // null = everyone in workspace
  kind: varchar('kind', { length: 30 }).notNull(), // sla_breach | webhook_offline | insight | team_note
  description: text('description').notNull(),
  link: varchar('link', { length: 500 }),
  readAt: ts('read_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('idx_notifications_tenant').on(t.tenantId, t.createdAt)]);

/** GET /logs — workspace-level activity (distinct from campaign_logs). */
export const workspaceLogs = pgTable('workspace_logs', {
  id: id(),
  tenantId: tenantId(),
  actorId: uuid('actor_id'),
  description: text('description').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Page analytics when Umami is not connected: daily visit counters per deployment. */
export const pageVisits = pgTable('page_visits', {
  id: id(),
  tenantId: tenantId(),
  deploymentId: uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  visits: integer('visits').notNull().default(0),
}, (t) => [uniqueIndex('idx_page_visits_day').on(t.deploymentId, t.day)]);

/** Stored page files when no S3/R2 bucket is configured (demo + tests). */
export const storedFiles = pgTable('stored_files', {
  path: varchar('path', { length: 700 }).primaryKey(),
  contentType: varchar('content_type', { length: 120 }).notNull(),
  dataBase64: text('data_base64').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Non-tenant super admins (TOTP). */
export const superAdmins = pgTable('super_admins', {
  id: id(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 500 }).notNull(),
  totpSecretEncrypted: text('totp_secret_encrypted'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('idx_super_admins_email').on(t.email)]);

/**
 * Proposed: Super Admin platform settings (branding, pricing & limits, payments, email, AI, Telegram, signup).
 * One row per section; values override the environment. Secret fields are stored encrypted.
 */
export const platformSettings = pgTable('platform_settings', {
  section: varchar('section', { length: 40 }).primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: varchar('updated_by', { length: 255 }),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
