# Camplo

Campaign decision engine — "See everything. Miss nothing." Built from the Camplo Design Spec v2.0, PRD v2,
Build Spec (consolidated), Data Model, AI Capability Map v2, Agent Architecture Spec and the Architecture Decision
Ledger Delta v1.0 (ADL). Where the ADL and older documents disagree, the ADL wins.

It is separate from the Finora Android app in the rest of this repo; nothing here is imported by it.

## Run it

```bash
cd camplo
npm install
npm run dev          # http://localhost:4173 — embedded Postgres (PGlite), demo workspace seeded
npm run typecheck
npm test             # domain rules + end-to-end API tests
```

Demo login: `marcus@northbeam.demo` / `camplo-demo` (workspace "Northbeam Growth", Watchtower plan).

## Architecture

```
public/            web client — vanilla JS, hash routing, no build step (app.js, icons.js, styles.css)
api/index.js       Vercel function: every non-static request → Express app (compiled to dist/)
server/
  app.ts           Express: oRPC API at /api, SSE (/api/rt/*), signed ingest webhooks, hosted pages (/sites/*), cron
  routes/          oRPC router (Zod-validated, ~145 procedures incl. super-admin)
  services/        use-cases: auth, workspace/team, campaigns, leads, notes, pages, SLA, settings, intelligence, admin/billing
  domain/rules.ts  pure Level-0 rules: double SLA timer, ownership paths A/B/C, Health Pulse, webhook state, plan gating
  ai/              router (BYOK → fallback → Camplo OpenRouter), Hindsight memory, tools, WorkerContract workers,
                   LangGraph main agent, intelligence engine (Levels 1–4 + memory measurement)
  jobs/            one BullMQ queue per ADL §6 job when DRAGONFLY_URL is set; otherwise inline jobs + idempotent sweeps
  rt/hub.ts        SSE fan-out for the 8 ADL D-NEW-5 channels (in-process; Redis bridge when DRAGONFLY_URL is set)
  db/              Drizzle schema (ADL §3 data model + additions below), migrations, demo seed
server/worker.ts   BullMQ worker process — one Worker per queue + cron sweeps (needs DRAGONFLY_URL)
Dockerfile, docker-compose.yml, Caddyfile   ADL D-7/D-7a/D-7b/D-26 self-hosting: app + worker + Postgres + Dragonfly + Caddy
```

Every list endpoint uses the ADL P-4 envelope: `?limit=` (default 50, max 100) and `?cursor=` in,
`{ data, next_cursor, has_more }` out (plus endpoint extras such as `workspace_avg_conversion_rate` on `/pages`).
Plan-gated calls answer `403 { reason: "plan_limit", required_plan }` and the client opens the upgrade modal.

Queues (ADL §6): `deployment-processing`, `sla-timers` (delayed job at `received_at + threshold`, id in
`leads.sla_job_id`, cancelled on respond), `daily-summaries`, `ai-intelligence` (30 s limit), `telegram-notifications`,
`early-warning` (closes the 72 h window), `retrospective-generation` (5 min limit, stores the PDF), `campaign-memory-measurement`,
`cross-tool-sla-check` (every 30 min), `rollback-cleanup`, `suspension-grace` (pages go offline 7 days after suspension).
Without a queue the same work runs inline and the time-based rules run as sweeps (every minute on traffic, and on `/api/cron`).

Database: Postgres via `DATABASE_URL`; without it, embedded PGlite (in-memory, or `PGLITE_DIR` to persist) runs the
same migrations. Money is stored as fixed-precision numeric in the campaign's currency; every `_encrypted` column uses AES-256-GCM.

Intelligence works without any AI key: Level 1 alerts are deterministic, and chat falls back to a rule-based answerer
over live workspace data. With a key (BYOK in Settings → AI Provider, or `OPENROUTER_API_KEY`), Levels 2–4
recommendations and the LangGraph agent are enabled. `apply_action` is stored but dormant (Autopilot is v2).

## Environment

ADL §5 names are primary; the older names in brackets still work.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` (or `POSTGRES_URL`) | Postgres connection. **Required for real use** — without it data is per-instance and ephemeral |
| `DRAGONFLY_URL` (`REDIS_URL`) | BullMQ queues + cross-instance SSE |
| `JWT_SECRET` | HS256 signing key. Required in production |
| `MAGIC_LINK_SIGNING_SECRET` | Signs Telegram acknowledge buttons (falls back to `JWT_SECRET`) |
| `MAGIC_LINK_EXPIRY_SECONDS`, `ACKNOWLEDGMENT_LINK_EXPIRY_SECONDS` | 900 / 259200 |
| `ENCRYPTION_KEY` | 32 bytes, base64 or hex. Required in production |
| `AI_KEY_ENCRYPTION_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, `INTEGRATION_KEY_ENCRYPTION_SECRET`, `TELEGRAM_TOKEN_ENCRYPTION_SECRET` | Optional per-family keys; each defaults to an HKDF subkey of `ENCRYPTION_KEY`. Ciphertext is tagged with its family |
| `ADMIN_TOTP_SECRET` (`SUPER_ADMIN_TOTP_SECRET`), `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | Super Admin (email + TOTP) |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID` (or `POLAR_PRODUCT_ID_GROWTH/WATCHTOWER`), `POLAR_ORGANIZATION_ID` | Billing — checkout sessions are created through the Polar API; `POLAR_CHECKOUT_URL_<PLAN>` static links are a fallback |
| `OPENROUTER_API_KEY`, `CAMPLO_DEFAULT_AI_PROVIDER`, `MODEL_QUICK/STANDARD/DEEP/STRATEGIC` | Camplo-provided AI and tier → model mapping |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Optional Camplo-wide bot; webhook `secret_token` derivation |
| `STORAGE_PROVIDER`, `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` (`S3_*`, AWS vars) | R2/S3 object storage; Postgres `stored_files` otherwise |
| `BASE_DOMAIN` (`PAGES_BASE_DOMAIN`), `MAX_ZIP_SIZE_MB`, `DEFAULT_STORAGE_QUOTA_GB` | Page hosting |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SUPPORT_EMAIL` | Email via SMTP (or `RESEND_API_KEY`; console when neither is set) |
| `ROLLBACK_RETENTION_DAYS`, `EARLY_WARNING_HOURS`, `NOTE_EDIT_WINDOW_SECONDS`, `AI_PANEL_TIMEOUT_SECONDS`, `AI_CACHE_TTL_SECONDS` | Feature flags (30 / 72 / 7200 / 10 / 1800) |
| `APP_URL` | Public base URL used in links and webhook URLs |
| `SEED_DEMO` | `false` to skip the demo workspace on an empty database |
| `DEMO_PASSWORD` | Password for demo users (default `camplo-demo`) |
| `AUTO_ACTIVATE` | `true` activates self-serve signups immediately (otherwise pending review) |
| `ALLOW_DIRECT_PLAN_CHANGE` | `true` lets upgrades apply without Polar checkout (demo/testing) |
| `CRON_SECRET` | Bearer token for `/api/cron` (Vercel Cron sends it automatically) |
| `HINDSIGHT_API_URL`, `HINDSIGHT_API_KEY` | Hindsight memory (one bank per workspace); relational fallback otherwise |

## Super Admin console

`/admin` is a separate sign-in (ADL D-33): email + password + a 6-digit TOTP code from an authenticator app.

- **Accounts** — activate / suspend / flag; edit business and owner details, plan, fee override, storage quota,
  notification email and SLA threshold; internal notes; per-account history. Aggregate counts only, never lead or page content.
- **Platform settings** (`platform_settings` table, values override env vars; blank = back to the env default):
  branding (product name used across the app, emails, share pages and PDFs; support email; sender name),
  pricing & limits (price, campaigns, deployments, members, connected tools and AI budget per plan; extra-deployment
  add-on; currency), payments (Polar token, webhook secret, organization, product IDs, checkout links, pay-free plan
  changes), email (SMTP / Resend), AI (OpenRouter key and model per tier), Telegram (platform bot) and signup
  (auto-activate, default plan). Secrets are encrypted, never sent back (masked only) and can be cleared. Each section
  has a connection test where it applies.
- **Audit log** — every platform change (secret values never logged).
The first Super Admin is created from `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` and `ADMIN_TOTP_SECRET` (base32) on the
first login attempt; once a database is attached, changing those variables does not change an existing admin.

## Self-hosting (ADL D-7, DokPloy)

```bash
cp .env.example .env   # or create it: JWT_SECRET, ENCRYPTION_KEY, APP_URL, APP_HOST, BASE_DOMAIN, POSTGRES_PASSWORD, …
docker compose up -d --build
```

The image runs the web/API server; the `worker` service runs `dist/server/worker.js` from the same image. Caddy terminates
TLS for `APP_HOST`, every `<page>.BASE_DOMAIN` subdomain and verified custom domains; it asks `/api/caddy/ask` before
issuing any certificate. Point a wildcard DNS record for `*.BASE_DOMAIN` at the host.

## Deploying to Vercel

`vercel.json` sets root-relative build settings (project root directory: `camplo`): `npm run vercel-build` compiles
`server/` to `dist/`, static files come from `public/`, and everything else rewrites to the `api/index.js` function.
A daily Vercel Cron (the Hobby-plan limit) hits `/api/cron`; sweeps also run at most once a minute on incoming traffic. On Pro, make the cron hourly.

Known limits on Vercel without extra services:
- Without `DATABASE_URL` (or `POSTGRES_URL`) each function instance boots its own in-memory database (~6 s cold start).
  The demo seed is deterministic there (same ids, tokens and subdomains on every instance), so logins work across
  instances, but **writes stay on the instance that handled them** and vanish when it is recycled. Refresh sessions are
  per-instance too, so the demo deploy sets `ACCESS_TOKEN_TTL_SECONDS=43200`. Attach Postgres (e.g. Neon) for real data.
- SSE streams are cut at the function's max duration; the client reconnects automatically. Cross-instance events need `REDIS_URL`.
- Uploaded pages and logos go to Postgres unless S3/R2 is configured.

## Schema additions beyond the Data Model

Columns: `tenants.team_size / suspended_at / notification_prefs`, `users.notify_enabled / notify_channel / removed_at`,
`deployments.serving_state / vip / failure_reason`, `leads.sla_alert_sent_at`, `notes.title / meeting_date / via`,
`insights.category / dedupe_key`, `inbound_webhooks.campaign_id`, `ai_provider_configs.last_refresh_at`.
Tables: `sessions` (rotating refresh tokens), `one_time_tokens` (reset/invite/ack/magic-login links), `notifications`,
`workspace_logs`, `page_visits`, `stored_files`, `super_admins`, `platform_settings` (migration 0001; also makes
`admin_action_log.target_tenant_id` nullable for platform-wide entries).

## ADL delta — how each decision landed

Built as specified: D-2/D-3 (tenant id on every query), D-4, D-5/D-6 (named queues), D-9 → Polar, D-10/D-11 (binary,
irreversible lead state), D-12 (AI is read-only), D-13 (delayed SLA job + cancellation), D-14 (single-use links),
D-15, D-16, D-17–D-23, D-24 (one-version rollback), D-26 (CNAME + Caddy), D-27/D-28, D-29 (multi-provider BYOK),
D-30 (own router over OpenRouter), D-31 (10 s panel timeout), D-33/D-34, D-35 superseded by SSE, and D-NEW-1 … D-NEW-25
(campaign status follows the Health Pulse; paused/complete are operator states). P-2 magic-link login (15 min,
single use) sits next to password login.

Deviations and interpretations — review these:
- **D-1 TanStack Start**: the web client is a no-build vanilla JS SPA over the same API, not TanStack Start. The API
  contract is framework-agnostic, so a TanStack Start client can replace `public/` without server changes.
- **Non-negotiable #3 (`deployment_id` on every lead)**: leads from operator-configured inbound webhooks
  (`/api/v1/hooks/:id`) have no page, so `leads.deployment_id` is nullable for them. Page leads always carry it.
  Making it strictly required means binding each inbound webhook to a page — say if you want that.
- **P-6 Telegram callback format**: Telegram limits `callback_data` to 64 bytes, so the button carries
  `ack:{lead_id hex}:{hmac16}`; the HMAC covers the full `acknowledge:{lead}:{user}:{tenant}` string.
- **GET `/api/acknowledge/:token`** redirects to the acknowledge screen instead of acknowledging: mail scanners prefetch
  GET links and would burn single-use tokens. The screen performs the POST.
- **D-NEW-24 conversion**: Camplo hosts the pages, so visits are counted by Camplo itself rather than Umami; the
  comparison therefore shows without an analytics connection.
- **D-NEW-13 cross-tool SLA**: rules are evaluated from lifecycle events the tool sends Camplo (receive mode; identity
  mapping is created on the first event, matched by contact id or email). Aggregate rules (open-rate drop, spend,
  CPL) need query-mode API clients per provider and are configurable but not yet evaluated.
- **D-NEW-26 OAuth write scopes**: OAuth connect flows need registered client ids per provider and are not built;
  integrations connect by API key or webhook today.

## Spec clarifications taken

- Webhook health: *stale* after `min(threshold, 60)` minutes without traffic, *offline* at ≥ 120 minutes.
- Insufficient evidence: fewer than 100 leads **and** under 14 days of data → a Monitoring card that auto-resolves.
- AI provider "Verify" makes a minimal completion call; it confirms the key and model name, not quota.
