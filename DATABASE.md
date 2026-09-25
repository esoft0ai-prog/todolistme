# Finora database

* Engine: **SQLite via expo-sqlite, compiled with SQLCipher** (AES-256, 256-bit random raw key from the Android Keystore).
* File: `finora.db` in the app's private data directory (not readable by other apps; excluded from Android backup and device transfer).
* Pragmas: `foreign_keys = ON`, `journal_mode = WAL`, `secure_delete = ON`.
* Schema source: [`src/db/schema.ts`](src/db/schema.ts). Migration runner: [`src/db/migrate.ts`](src/db/migrate.ts).

## Conventions

| Convention | Detail |
|---|---|
| Primary keys | `TEXT` UUID v4 (default categories use stable ids such as `sys-exp-food`). Enables merging backups and future sync. |
| Money | `INTEGER` minor units (kobo, cents). Column names end in `_minor`. Never floats. |
| Dates | `TEXT` `YYYY-MM-DD` (calendar dates, timezone-free). |
| Timestamps | `TEXT` ISO-8601 (`created_at`, `updated_at`). |
| Booleans | `INTEGER` 0/1. |
| Sample data | `is_demo` flag on user tables so sample data is identifiable and removable. |
| Integrity | `CHECK` constraints mirror validation rules (positive amounts, enums, date order where possible); `FOREIGN KEY`s with explicit `ON DELETE` behaviour. |

## Migrations

Migrations are an ordered array; each has a version number and SQL. On start-up the runner:

1. enables foreign keys,
2. reads `PRAGMA user_version`,
3. refuses to continue if the database is newer than the app (prevents data loss after a downgrade),
4. applies each pending migration inside its own transaction and bumps `user_version`.

Rules: never edit a shipped migration; append a new one. Backups record `schemaVersion`; importing a backup from a newer schema is refused with an explanatory message.

## Tables

### preferences
`key` PK, `value` (JSON), `updated_at`. Typed and validated by `services/preferences.ts` (unknown keys ignored, bad values fall back to defaults). Security keys (`appLockEnabled`, `biometricEnabled`, `autoLockSeconds`, `hideInRecents`, `onboardingComplete`) are *device-local* and never exported/restored.

### accounts
`id`, `name`, `type` (cash | bank | mobile_wallet | savings | business | other), `currency` (ISO 4217), `opening_balance_minor`, `color`, `icon`, `archived`, `is_demo`, timestamps.
**No balance column.** The balance is derived (`services/accounts.ts → BALANCE_SQL`):

| Transaction type | effect on `account_id` | effect on `to_account_id` |
|---|---|---|
| income, loan_received, savings_withdrawal | + amount | savings_withdrawal: − (to_amount ?? amount) from the goal's linked account |
| expense, debt_repayment | − amount | — |
| transfer | − amount | + (to_amount ?? amount) |
| savings_deposit | − amount | + (to_amount ?? amount) into the goal's linked account |

### categories
`id`, `name`, `kind` (income | expense), `icon`, `color`, `is_system`, `archived`, `is_demo`, timestamps. Index `(kind, archived)`.

### tags / transaction_tags
`tags(id, name UNIQUE COLLATE NOCASE, …)`; `transaction_tags(transaction_id → transactions ON DELETE CASCADE, tag_id → tags ON DELETE CASCADE, PK both)`. Orphan tags are removed automatically.

### transactions
| Column | Notes |
|---|---|
| `type` | income, expense, transfer, debt_repayment, loan_received, savings_deposit, savings_withdrawal |
| `amount_minor` | `> 0`, in `currency` (the account's currency) |
| `currency`, `fx_rate`, `base_amount_minor` | rate snapshot to the base currency at entry time; all analytics use `base_amount_minor` |
| `date`, `time` | calendar date + optional `HH:MM` |
| `account_id` | → accounts `ON DELETE RESTRICT` (accounts with history must be archived) |
| `to_account_id`, `to_amount_minor` | transfer destination / goal's linked account; `to_amount` for cross-currency |
| `category_id` | → categories `ON DELETE SET NULL` |
| `debt_id` | → debts `ON DELETE SET NULL` |
| `goal_id` | → savings_goals `ON DELETE SET NULL` |
| `recurring_id` | → recurring_transactions `ON DELETE SET NULL` |
| `description`, `payment_method`, `notes`, `reference`, `is_demo`, timestamps | |

Constraints: `CHECK (type <> 'transfer' OR (to_account_id IS NOT NULL AND to_account_id <> account_id))`.
Indexes: `(date)`, `(type, date)`, `(account_id, date)`, `(to_account_id)`, `(category_id, date)`, `(debt_id)`, `(goal_id)`, **UNIQUE `(recurring_id, date)` WHERE recurring_id IS NOT NULL** (guarantees each recurring occurrence is created once).

### budgets / budget_categories
`budgets(id, name, period (weekly|monthly|custom), limit_minor > 0, start_date (anchor or range start), end_date, alert_threshold (0,1], archived, is_demo, …)`; `budget_categories(budget_id → CASCADE, category_id → CASCADE)`. No categories = all expenses.

### debts / debt_schedule / debt_payments
`debts`: `lender_name`, `debt_type`, `currency`, `principal_minor > 0`, `interest_type` (none | fixed_amount | flat_percentage | simple_annual | reducing_balance | custom_schedule), `interest_value ≥ 0` (percent, or minor units for fixed_amount), `payment_frequency` (one_time | weekly | biweekly | monthly | quarterly | yearly), `minimum_payment_minor`, `installment_count`, `start_date`, `first_due_date`, `end_date`, `penalty_type` (none | fixed | percentage), `penalty_value`, `paid_before_minor` (repaid before tracking), `total_payable_override_minor`, `notes`, `status` (active | paid_off | archived).
`debt_schedule(debt_id → CASCADE, due_date, amount_minor > 0)` — user-defined instalments.
`debt_payments(debt_id → CASCADE, kind (payment | penalty | adjustment), amount_minor (signed only for adjustments), date, transaction_id → transactions SET NULL, UNIQUE when not null, notes, …)`.
Outstanding balance = total payable + penalties + adjustments − paid_before − payments; `status` is re-synced after every change.

### savings_goals
`name`, `target_minor > 0`, `currency`, `initial_minor`, `start_date`, `deadline`, `linked_account_id` → accounts SET NULL, `icon`, `color`, `reminder_frequency`, `status` (active | completed | archived), `notes`. Saved amount = initial + deposits − withdrawals (transactions with `goal_id`).

### recurring_transactions
Template fields (type, amount, accounts, category, debt, goal, description, payment method), rule (`frequency`, `interval`, `unit`, `start_date`, `end_date`), `is_bill`, `auto_create`, `remind_days_before` (−1 = none), `last_generated_date`, `active`.

### reminders
`kind` (debt | custom | bill | savings), `entity_id`, `title`, `message`, `offset_days` (debt reminders), `date` + `repeat` (custom), `time_of_day`, `enabled`. Index `(kind, entity_id)`.

### financial_events
One-off calendar items: `title`, `date`, `kind` (bill | income | savings | note), `amount_minor`, `notes`, `remind`.

### notifications / scheduled_notifications
`scheduled_notifications(key PK, os_id, hash, fire_at, channel, title, body, entity_type, entity_id)` is the registry of what is armed with Android. `notifications(id, key UNIQUE, channel, title, body, fired_at, entity_type, entity_id, read)` is the history. Both are device-specific and not part of backups.

### exchange_rates
`currency` PK, `rate > 0` (1 unit = rate × base currency), `updated_at`.

### health_snapshots
`month` PK (`YYYY-MM`), `total`, `components` (JSON), `created_at` — used to explain score changes.

### audit_logs
`id`, `entity_type`, `entity_id`, `action` (create | update | delete | restore | import | export | security | system), `summary`, `created_at`. Local only, pruned to the newest 5 000 rows.

## Entity relationships

```
accounts ─┬─< transactions >─┬─ categories
          │        │  │  │    ├─ debts ─┬─< debt_payments (>─ transactions)
          │        │  │  │    │         └─< debt_schedule
          │        │  │  └────┴─ savings_goals (linked_account_id ─> accounts)
          │        │  └── recurring_transactions
          │        └──< transaction_tags >── tags
          └─< recurring_transactions
budgets ──< budget_categories >── categories
reminders (kind='debt') ── debts        financial_events, exchange_rates,
notifications, scheduled_notifications, health_snapshots, audit_logs, preferences
```

## Backup format

```json
{
  "format": "finora-backup",
  "version": 1,
  "schemaVersion": 1,
  "appVersion": "1.0.0",
  "createdAt": "2026-09-25T14:00:00.000Z",
  "baseCurrency": "NGN",
  "counts": { "transactions": 76, "...": 0 },
  "checksum": "<sha256 of canonical JSON of data>",
  "data": { "accounts": [ { "id": "…", "name": "Cash", "...": "..." } ], "...": [] }
}
```

Tables are listed parent-first in `BACKUP_TABLES` so restores respect foreign keys. On import every row is sanitised (whitelisted columns, types, enums, dates, text length), duplicate ids are rejected, cross-table references are checked, the checksum is verified, and the restore runs inside a single transaction followed by `PRAGMA foreign_key_check`.
