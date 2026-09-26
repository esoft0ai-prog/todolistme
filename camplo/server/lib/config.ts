/** All tunables come from the environment — never hardcoded (Build Spec: Token Expiry Reference). */
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
/** First non-empty value — ADL v1.0 names come first, earlier names stay as fallbacks. */
const env = (...names: string[]) => { for (const n of names) { const v = process.env[n]; if (v) return v; } return ''; };

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  appUrl: process.env.APP_URL ?? 'http://localhost:4173',
  databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '',
  /** Where embedded PGlite keeps data when DATABASE_URL is unset. Empty = in-memory. */
  pgliteDir: process.env.PGLITE_DIR ?? '',
  seedDemo: process.env.SEED_DEMO !== 'false',

  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-jwt-secret-change-me',
  accessTokenTtlSeconds: num(process.env.ACCESS_TOKEN_TTL_SECONDS, 15 * 60),
  sessionInactivityDays: num(process.env.SESSION_INACTIVITY_DAYS, 7),
  /** 32-byte key, base64 or hex. Used for every `_encrypted` column (AES-256-GCM). */
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  /** Optional per-domain keys (ADL §5). Unset → an HKDF subkey of ENCRYPTION_KEY for that domain. */
  encryptionKeys: {
    ai: env('AI_KEY_ENCRYPTION_SECRET'),
    webhook: env('WEBHOOK_SECRET_ENCRYPTION_KEY'),
    integration: env('INTEGRATION_KEY_ENCRYPTION_SECRET'),
    telegram: env('TELEGRAM_TOKEN_ENCRYPTION_SECRET'),
  },

  /** Signs magic-link login and Telegram acknowledge callbacks (falls back to JWT_SECRET). */
  magicLinkSigningSecret: env('MAGIC_LINK_SIGNING_SECRET'),
  magicLinkExpirySeconds: num(process.env.MAGIC_LINK_EXPIRY_SECONDS, 900),
  acknowledgmentLinkExpirySeconds: num(process.env.ACKNOWLEDGMENT_LINK_EXPIRY_SECONDS, 259200),
  passwordResetExpirySeconds: num(process.env.PASSWORD_RESET_EXPIRY_SECONDS, 3600),
  invitationExpiryDays: num(process.env.INVITATION_EXPIRY_DAYS, 7),

  maxZipSizeMb: num(process.env.MAX_ZIP_SIZE_MB, 100),
  pagesBaseDomain: env('BASE_DOMAIN', 'PAGES_BASE_DOMAIN') || 'camplo.app',
  defaultStorageQuotaBytes: num(process.env.DEFAULT_STORAGE_QUOTA_GB, 5) * 1024 ** 3,
  adminUrl: env('ADMIN_URL'),
  supportEmail: process.env.SUPPORT_EMAIL ?? 'support@camplo.app',

  // AI routing (Capability Map Part 6). Tier → model mapping is config, not code.
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  models: {
    quick: process.env.MODEL_QUICK ?? 'meta-llama/llama-3.3-70b-instruct',
    standard: process.env.MODEL_STANDARD ?? 'anthropic/claude-sonnet-5',
    deep: process.env.MODEL_DEEP ?? 'anthropic/claude-sonnet-5',
    strategic: process.env.MODEL_STRATEGIC ?? 'anthropic/claude-opus-5-5',
  },
  aiCacheTtlSeconds: num(process.env.AI_CACHE_TTL_SECONDS, 30 * 60),
  manualRefreshDebounceMinutes: num(process.env.MANUAL_REFRESH_DEBOUNCE_MINUTES, 15),

  // Hindsight (Agent Architecture Part 6) — self-hosted via Docker.
  hindsightApiUrl: process.env.HINDSIGHT_API_URL ?? '',
  hindsightApiKey: process.env.HINDSIGHT_API_KEY ?? '',

  // Worker controls (Agent Architecture Part 9)
  workerMaxDepth: num(process.env.WORKER_MAX_DEPTH, 2),
  workerMaxConcurrent: num(process.env.WORKER_MAX_CONCURRENT, 4),
  workerDefaultTimeoutSeconds: num(process.env.WORKER_DEFAULT_TIMEOUT_SECONDS, 300),
  workerMaxToolCalls: num(process.env.WORKER_MAX_TOOL_CALLS, 20),

  // Queues: BullMQ over Dragonfly/Redis when set; otherwise jobs run inline / via cron.
  redisUrl: env('DRAGONFLY_URL', 'REDIS_URL'),
  cronSecret: process.env.CRON_SECRET ?? '',

  // Email: SMTP (ADL) or the Resend HTTP API — logged to console when neither is set.
  smtp: { host: env('SMTP_HOST'), port: num(process.env.SMTP_PORT, 587), user: env('SMTP_USER'), pass: env('SMTP_PASS') },
  resendApiKey: env('RESEND_API_KEY'),
  emailFrom: env('SMTP_FROM', 'EMAIL_FROM') || 'Camplo <no-reply@camplo.app>',

  // Polar.sh billing
  polarWebhookSecret: env('POLAR_WEBHOOK_SECRET'),
  polarAccessToken: env('POLAR_ACCESS_TOKEN'),
  polarOrganizationId: env('POLAR_ORGANIZATION_ID'),
  polarApiUrl: env('POLAR_API_URL') || 'https://api.polar.sh',
  /** Product per plan: POLAR_PRODUCT_ID_GROWTH etc., falling back to the single POLAR_PRODUCT_ID. */
  polarProductId: (plan: string) => env(`POLAR_PRODUCT_ID_${plan.toUpperCase()}`, 'POLAR_PRODUCT_ID'),

  // Telegram: optional Camplo-wide bot + webhook secret (workspaces can also connect their own bot).
  telegramBotToken: env('TELEGRAM_BOT_TOKEN'),
  telegramWebhookSecret: env('TELEGRAM_WEBHOOK_SECRET'),

  // Object storage (R2 / S3-compatible). When unset, page files live in Postgres.
  storageProvider: env('STORAGE_PROVIDER') || 'r2',
  s3Endpoint: env('STORAGE_ENDPOINT', 'S3_ENDPOINT'),
  s3Bucket: env('STORAGE_BUCKET', 'S3_BUCKET'),
  s3AccessKey: env('STORAGE_ACCESS_KEY', 'AWS_ACCESS_KEY_ID'),
  s3SecretKey: env('STORAGE_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY'),
  s3Region: env('STORAGE_REGION', 'AWS_REGION') || 'auto',

  superAdminEmail: process.env.SUPER_ADMIN_EMAIL ?? '',
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD ?? '',
  adminTotpSecret: env('ADMIN_TOTP_SECRET', 'SUPER_ADMIN_TOTP_SECRET'),

  // Feature flags (ADL §5)
  rollbackRetentionDays: num(process.env.ROLLBACK_RETENTION_DAYS, 30),
  earlyWarningHours: num(process.env.EARLY_WARNING_HOURS, 72),
  noteEditWindowSeconds: num(process.env.NOTE_EDIT_WINDOW_SECONDS, 7200),
  aiPanelTimeoutSeconds: num(process.env.AI_PANEL_TIMEOUT_SECONDS, 10),
  defaultAiProvider: env('CAMPLO_DEFAULT_AI_PROVIDER') || 'openrouter',
} as const;

export const isProd = config.env === 'production';
