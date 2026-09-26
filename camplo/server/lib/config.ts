/** All tunables come from the environment — never hardcoded (Build Spec: Token Expiry Reference). */
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

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

  magicLinkExpirySeconds: num(process.env.MAGIC_LINK_EXPIRY_SECONDS, 900),
  acknowledgmentLinkExpirySeconds: num(process.env.ACKNOWLEDGMENT_LINK_EXPIRY_SECONDS, 259200),
  passwordResetExpirySeconds: num(process.env.PASSWORD_RESET_EXPIRY_SECONDS, 3600),
  invitationExpiryDays: num(process.env.INVITATION_EXPIRY_DAYS, 7),

  maxZipSizeMb: num(process.env.MAX_ZIP_SIZE_MB, 100),
  pagesBaseDomain: process.env.PAGES_BASE_DOMAIN ?? 'camplo.app',
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
  redisUrl: process.env.REDIS_URL ?? '',
  cronSecret: process.env.CRON_SECRET ?? '',

  // Email (Resend-compatible HTTP API) — logged to console when unset.
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: process.env.EMAIL_FROM ?? 'Camplo <no-reply@camplo.app>',

  // Polar.sh billing
  polarWebhookSecret: process.env.POLAR_WEBHOOK_SECRET ?? '',
  polarAccessToken: process.env.POLAR_ACCESS_TOKEN ?? '',

  // Object storage (R2 / S3-compatible). When unset, page files live in Postgres.
  s3Endpoint: process.env.S3_ENDPOINT ?? '',
  s3Bucket: process.env.S3_BUCKET ?? '',

  superAdminEmail: process.env.SUPER_ADMIN_EMAIL ?? '',
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD ?? '',
} as const;

export const isProd = config.env === 'production';
