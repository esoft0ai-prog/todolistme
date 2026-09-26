# Camplo

Campaign decision engine — "See everything. Miss nothing." Built from the Camplo Design Spec v2.0, PRD v2,
Build Spec (consolidated), Data Model, AI Capability Map v2 and Agent Architecture Spec.

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
  jobs/            BullMQ when REDIS_URL is set; otherwise inline jobs + sweeps on traffic and /api/cron
  rt/hub.ts        SSE fan-out (in-process; Redis bridge when REDIS_URL is set)
  db/              Drizzle schema (31 spec tables + additions below), migrations, demo seed
server/worker.ts   BullMQ worker process (only needed with REDIS_URL)
```

Database: Postgres via `DATABASE_URL`; without it, embedded PGlite (in-memory, or `PGLITE_DIR` to persist) runs the
same migrations. Money is stored as fixed-precision numeric in the campaign's currency; every `_encrypted` column uses AES-256-GCM.

Intelligence works without any AI key: Level 1 alerts are deterministic, and chat falls back to a rule-based answerer
over live workspace data. With a key (BYOK in Settings → AI Provider, or `OPENROUTER_API_KEY`), Levels 2–4
recommendations and the LangGraph agent are enabled. `apply_action` is stored but dormant (Autopilot is v2).

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` (or `POSTGRES_URL`) | Postgres connection. **Required for real use** — without it data is per-instance and ephemeral |
| `JWT_SECRET` | HS256 signing key. Required in production |
| `ENCRYPTION_KEY` | 32 bytes, base64 or hex, for encrypted columns. Required in production |
| `APP_URL` | Public base URL used in links and webhook URLs |
| `SEED_DEMO` | `false` to skip the demo workspace on an empty database |
| `DEMO_PASSWORD` | Password for demo users (default `camplo-demo`) |
| `AUTO_ACTIVATE` | `true` activates self-serve signups immediately (otherwise pending review) |
| `ALLOW_DIRECT_PLAN_CHANGE` | `true` lets upgrades apply without Polar checkout (demo/testing) |
| `CRON_SECRET` | Bearer token for `/api/cron` (Vercel Cron sends it automatically) |
| `REDIS_URL` | BullMQ queues + cross-instance SSE |
| `OPENROUTER_API_KEY`, `MODEL_QUICK/STANDARD/DEEP/STRATEGIC` | Camplo-provided AI and tier → model mapping |
| `HINDSIGHT_API_URL`, `HINDSIGHT_API_KEY` | Hindsight memory (one bank per workspace); relational fallback otherwise |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email (logged to console when unset) |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_CHECKOUT_URL_GROWTH/WATCHTOWER` | Billing |
| `S3_ENDPOINT`, `S3_BUCKET`, `AWS_REGION` (+ AWS credentials) | Page/logo storage; Postgres `stored_files` otherwise |
| `PAGES_BASE_DOMAIN` | Host suffix for hosted pages (also served at `/sites/<subdomain>/`) |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | Super-admin (TOTP) bootstrap |

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
Tables: `sessions` (rotating refresh tokens), `one_time_tokens` (reset/invite/ack links), `notifications`,
`workspace_logs`, `page_visits`, `stored_files`, `super_admins`.

## Spec clarifications taken

- Webhook health: *stale* after `min(threshold, 60)` minutes without traffic, *offline* at ≥ 120 minutes.
- Insufficient evidence: fewer than 100 leads **and** under 14 days of data → a Monitoring card that auto-resolves.
- AI provider "Verify" makes a minimal completion call; it confirms the key and model name, not quota.
