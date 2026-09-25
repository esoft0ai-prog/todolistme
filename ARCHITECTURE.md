# Finora architecture

Finora is a layered, offline-first React Native application. Every layer depends only on the layers beneath it, and the business rules are plain TypeScript that runs (and is tested) without React Native.

```
┌──────────────────────────────────────────────────────────────────────┐
│ screens/  navigation/  ui/        React components (presentation)     │
├──────────────────────────────────────────────────────────────────────┤
│ state/                            Zustand store, mutate(), useQuery() │
├──────────────────────────────────────────────────────────────────────┤
│ services/                         Use-cases: validation + DB + audit  │
│                                   (transactions, debts, budgets, …)   │
├──────────────────────┬───────────────────────────────────────────────┤
│ domain/              │ db/                   platform/                │
│ pure business logic  │ schema, migrations,   expo adapters:           │
│ (money, debt math,   │ SqlDriver interface,  notifications, secure     │
│ budgets, health,     │ expo (SQLCipher) &    store, biometrics, files, │
│ planner, assistant,  │ web drivers, mappers  screen privacy            │
│ backup, crypto)      │                                                 │
└──────────────────────┴───────────────────────────────────────────────┘
```

## Principles

1. **The database is the single source of truth.** Screens never cache business data; they query services through `useQuery`, which re-runs whenever `dataVersion` is bumped by `mutate()`.
2. **Derived, never stored.** Account balances, debt balances, goal progress, budget status and health scores are computed from the ledger on read. There is no counter that can drift out of sync.
3. **Pure domain.** `src/domain` has no imports from React, Expo or the database. It is exhaustively unit-tested and portable (future web dashboard, sync server, etc.).
4. **Dependency injection at the edges.** Services receive a `ServiceContext` (`db`, `today()`, `now()`); platform features are behind interfaces (`SqlDriver`, `NotificationGateway`, `SecureStoreGateway`, `BiometricGateway`). Tests swap in Node SQLite, a fake scheduler, an in-memory secure store and a fixed clock.
5. **Idempotent background work.** Recurring transactions and notification scheduling can run any number of times (start, resume, after edits, after restore) and converge to the same state.

## Layers

### `src/domain` — business logic

| Module | Responsibility |
|---|---|
| `types.ts` | Every entity type. Money is integer minor units (`…Minor`), dates are `YYYY-MM-DD`. |
| `money.ts`, `currency.ts` | Parsing (`25k`, `1.5m`, `₦25,000.50`), formatting (deterministic, no `Intl` dependency), conversion. |
| `dates.ts` | Calendar-safe date math (UTC arithmetic on date strings), period presets, week starts. |
| `recurrence.ts` | Index-based recurrence (start + n·step) so month-end anchors never drift. |
| `debt.ts` | Six interest models, instalment plans, payment allocation, overdue detection, payoff projections, DTI, penalties, punctuality. |
| `budget.ts` | Period resolution (salary-day anchors, weekly anchors, custom), pace, projections, early warnings. |
| `savings.ts` | Goal progress, required weekly/monthly saving, on-track evaluation, projected completion. |
| `health.ts` | Transparent 5 × 20-point score and change explanations. |
| `reminderPlanner.ts` | Computes the complete set of notifications that *should* exist, and diffs against what *does* exist. |
| `assistant/` | Intent classification + entity extraction (`parser.ts`) and the answering engine (`engine.ts`) behind an `AssistantProvider` interface. |
| `backup.ts` | Backup format, row sanitisation against a column whitelist, integrity checksum, merge planning with duplicate detection. |
| `exporters.ts` | CSV (formula-injection safe) and self-contained HTML report. |
| `crypto.ts` | SHA-256, HMAC, PBKDF2 (verified against RFC/NIST vectors). |
| `validation.ts` | Field validation and duplicate detection shared by UI and services. |

### `src/db` — persistence

* `schema.ts` — ordered migrations (applied inside transactions, tracked with `PRAGMA user_version`) and `BACKUP_TABLES`, a typed description of every exportable column used to validate backups.
* `driver.ts` — the `SqlDriver` interface and `createSerializedDriver`, which wraps any raw executor with a FIFO mutex so an ad-hoc query can never interleave with an open `BEGIN … COMMIT` on the same connection. Transactions receive their own executor.
* `expoDriver.ts` — expo-sqlite + SQLCipher (`PRAGMA key` with the Keystore-held key, WAL, foreign keys, secure delete).
* `expoDriver.web.ts` — sql.js implementation used only by the browser preview/UI tests.
* `mappers.ts` — snake_case rows ↔ camelCase entities.

### `src/services` — use-cases

Each module validates input, performs the SQL inside a transaction, keeps dependent state consistent, and writes an audit entry. Key rules:

* `transactions.ts` — resolves the account currency, snapshots the exchange rate into `base_amount_minor`, clears fields that do not apply to the type, enforces category kinds, prevents debt over-repayment and goal over-withdrawal, maintains tags, keeps the linked `debt_payments` row in sync on create/edit/delete, and re-evaluates debt (`active`/`paid_off`) and goal (`active`/`completed`) status.
* `accounts.ts` — `BALANCE_SQL` derives balances from the ledger (see DATABASE.md for the sign rules).
* `debts.ts` — creation with optional "loan received" disbursement, repayments from an account (creates a ledger transaction) or from outside, penalties, signed adjustments, deletion with/without transactions, per-debt reminder offsets.
* `recurring.ts` — `materializeDue()` catches up all missed occurrences exactly once (`last_generated_date` + unique index on `(recurring_id, date)`); `projectedOccurrences()` feeds the calendar and upcoming lists.
* `analytics.ts` — totals, time series (day/week/month buckets), category breakdowns, balances, debt overview, upcoming items, health score inputs and monthly snapshots, dashboard aggregate.
* `notifications.ts` — the notification engine (below).
* `backup.ts` — export, replace/merge restore in one transaction with FK verification and device-local preference protection.
* `security.ts` — PIN hashing/verification with persistent lockout, DB key management, lock-on-resume rule.
* `demo.ts`, `search.ts`, `reports.ts`, `assistantData.ts`, `preferences.ts`, `rates.ts`, `audit.ts`.

### `src/platform` — native adapters

Thin wrappers that implement the service interfaces with Expo modules: `notifications.ts` (channels, permissions, date triggers, foreground handler, tap listener), `security.ts` (secure store, biometrics, `FLAG_SECURE`), `files.ts` (Storage Access Framework save, share sheet, file picker, safety snapshots).

### `src/state`

* `appStore.ts` — boot status, service context, preferences, lock state, `dataVersion`, unread count, toasts.
* `actions.ts` — `mutate(fn)` runs a service call, converts errors into friendly messages, bumps `dataVersion`, debounces a notification re-sync and optionally checks budget alerts. `updatePrefs()` persists preferences and applies side effects (screen privacy, re-planning reminders).
* `useQuery.ts` — loads data for a screen, re-runs on `dataVersion`/deps, discards stale responses.

### UI

`ui/theme.ts` holds dark and light palettes and a typography scale (multiplied for "larger text"). `ui/components` provides primitives (Screen, Card, Button, Chip, ListRow, ProgressBar, AnimatedMoney…), form controls (AmountField with shorthand parsing, native date/time pickers, SelectField/OptionSheet, SwitchRow, Sheet), SVG charts (Donut, grouped Bar, smooth Line/area, ProgressRing), a promise-based dialog host and toasts, and the PIN pad. Every interactive element has an accessibility role and label.

## Start-up sequence (`src/core/bootstrap.ts`)

1. Install the foreground notification handler.
2. Fetch (or create) the 256-bit database key from the Keystore.
3. Open the SQLCipher database and verify the key; on failure show a recovery screen (reset + restore from backup).
4. Run migrations (refusing databases from a newer app version).
5. Seed default categories (idempotent), load preferences, decide lock state, apply screen privacy.
6. In the background: materialise due recurring transactions, reconcile notifications, prune the audit log.

`App.tsx` then shows onboarding (first run), the lock screen (if enabled) or the navigator. Returning from background re-locks after the configured timeout and re-runs step 6.

## Notification engine

```
data change / app start / resume / restore
          │
          ▼
buildPlan()  ──►  planNotifications()  (pure, src/domain/reminderPlanner.ts)
          │         debts: N days before each unpaid instalment + overdue follow-ups (1,3,7,14,30 d)
          │         bills: recurring transactions with reminders
          │         savings: weekly/monthly goal nudges + 7-days-before-deadline
          │         custom reminders (repeating), calendar events, monthly backup nudge
          │         → filtered by master switch + channel toggles, never in the past,
          │           horizon 120 days, capped at 200 (Android allows ~500 alarms)
          ▼
diffSchedule(plan, registry)   keyed by stable key, compared by content hash
          │
          ▼
cancel removed/changed, schedule new  →  scheduled_notifications registry updated
```

* Delivered notifications are moved from the registry to the `notifications` history table on the next sync.
* If the OS lost alarms (vendor battery killers), entries whose OS id no longer exists are rescheduled.
* expo-notifications persists requests natively and re-arms them on `BOOT_COMPLETED`, `QUICKBOOT_POWERON` and `MY_PACKAGE_REPLACED`, so reminders survive app close, swipe-away and reboot without the app running.
* Budget warnings are immediate notifications raised after spending is recorded, de-duplicated per budget/period/level via the history table's unique key.

## Financial assistant

`parser.ts` normalises the question, scores it against weighted regex rules to pick one of 15 intents, and extracts amounts (`₦100,000`, `N250k`, `1.5 million`), periods (`last month`, `in March`, `last 3 months`), categories (with Nigerian synonyms), goal names, target dates and counts. `engine.ts` routes the intent to a calculator that queries an `AssistantDataSource` and returns text, calculation steps, itemised details, a tone and follow-up suggestions. To add an AI model later, implement `AssistantProvider` — the screen only depends on the interface, and the data source can be offered to the model as tools.

## Performance on low-end devices

* Hermes bytecode, R8 minification and resource shrinking, only `armeabi-v7a` + `arm64-v8a`.
* No chart, animation or date libraries; SVG charts are drawn once per data change. The only continuous animation is the skeleton pulse (native driver).
* Aggregations happen in SQL with indexes on `(type, date)`, `(account_id, date)`, `(category_id, date)`; lists paginate (60 rows per page) and use virtualised `SectionList`/`FlatList`.
* Tabs are lazy; screens load only what they display.

## Future extension points

See the table at the end of the README. The main hooks are the `SqlDriver` interface (alternative storage/sync), UUID keys + `updated_at` on every row and `planMerge()` (multi-device sync), `AssistantProvider` (AI), `createTransaction()` as the single ingestion path (bank statement import), and migrations for new entities.
