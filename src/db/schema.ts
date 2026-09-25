/**
 * SQLite schema, expressed as ordered migrations. `PRAGMA user_version` records
 * the applied version. Each migration runs inside a transaction; never edit a
 * shipped migration — append a new one.
 *
 * Conventions: TEXT UUID primary keys, integer minor-unit money columns,
 * ISO dates (YYYY-MM-DD) and ISO timestamps, `is_demo` flag on user data so
 * sample data can be identified and removed.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const TS = `created_at TEXT NOT NULL, updated_at TEXT NOT NULL`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  type TEXT NOT NULL CHECK (type IN ('cash','bank','mobile_wallet','savings','business','other')),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  opening_balance_minor INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  icon TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
  icon TEXT NOT NULL DEFAULT 'pricetag',
  color TEXT NOT NULL DEFAULT '#7C8CFF',
  is_system INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);
CREATE INDEX IF NOT EXISTS idx_categories_kind ON categories(kind, archived);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 40),
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);

CREATE TABLE IF NOT EXISTS debts (
  id TEXT PRIMARY KEY NOT NULL,
  lender_name TEXT NOT NULL CHECK (length(lender_name) BETWEEN 1 AND 80),
  debt_type TEXT NOT NULL CHECK (debt_type IN ('personal_loan','bank_loan','loan_app','family','friend','business','credit_purchase','other')),
  currency TEXT NOT NULL,
  principal_minor INTEGER NOT NULL CHECK (principal_minor > 0),
  interest_type TEXT NOT NULL CHECK (interest_type IN ('none','fixed_amount','flat_percentage','simple_annual','reducing_balance','custom_schedule')),
  interest_value REAL NOT NULL DEFAULT 0 CHECK (interest_value >= 0),
  payment_frequency TEXT NOT NULL CHECK (payment_frequency IN ('one_time','weekly','biweekly','monthly','quarterly','yearly')),
  minimum_payment_minor INTEGER NOT NULL DEFAULT 0 CHECK (minimum_payment_minor >= 0),
  installment_count INTEGER NOT NULL DEFAULT 0 CHECK (installment_count >= 0),
  start_date TEXT NOT NULL,
  first_due_date TEXT NOT NULL,
  end_date TEXT,
  penalty_type TEXT NOT NULL DEFAULT 'none' CHECK (penalty_type IN ('none','fixed','percentage')),
  penalty_value REAL NOT NULL DEFAULT 0 CHECK (penalty_value >= 0),
  paid_before_minor INTEGER NOT NULL DEFAULT 0 CHECK (paid_before_minor >= 0),
  total_payable_override_minor INTEGER,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid_off','archived')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);
CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(status);

CREATE TABLE IF NOT EXISTS debt_schedule (
  id TEXT PRIMARY KEY NOT NULL,
  debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0)
);
CREATE INDEX IF NOT EXISTS idx_debt_schedule_debt ON debt_schedule(debt_id, due_date);

CREATE TABLE IF NOT EXISTS savings_goals (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  target_minor INTEGER NOT NULL CHECK (target_minor > 0),
  currency TEXT NOT NULL,
  initial_minor INTEGER NOT NULL DEFAULT 0 CHECK (initial_minor >= 0),
  start_date TEXT NOT NULL,
  deadline TEXT,
  linked_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  icon TEXT NOT NULL DEFAULT 'flag',
  color TEXT NOT NULL DEFAULT '#22D3A6',
  reminder_frequency TEXT NOT NULL DEFAULT 'none' CHECK (reminder_frequency IN ('none','weekly','monthly')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);

CREATE TABLE IF NOT EXISTS recurring_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','expense','transfer','debt_repayment','savings_deposit','savings_withdrawal')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  debt_id TEXT REFERENCES debts(id) ON DELETE CASCADE,
  goal_id TEXT REFERENCES savings_goals(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  payment_method TEXT,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','biweekly','monthly','quarterly','yearly','custom')),
  interval INTEGER NOT NULL DEFAULT 1 CHECK (interval >= 1),
  unit TEXT NOT NULL DEFAULT 'month' CHECK (unit IN ('day','week','month','year')),
  start_date TEXT NOT NULL,
  end_date TEXT,
  is_bill INTEGER NOT NULL DEFAULT 0,
  auto_create INTEGER NOT NULL DEFAULT 1,
  remind_days_before INTEGER NOT NULL DEFAULT -1,
  last_generated_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);
CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_transactions(active);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','expense','transfer','debt_repayment','loan_received','savings_deposit','savings_withdrawal')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  base_amount_minor INTEGER NOT NULL,
  fx_rate REAL NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  time TEXT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  to_amount_minor INTEGER,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  debt_id TEXT REFERENCES debts(id) ON DELETE SET NULL,
  goal_id TEXT REFERENCES savings_goals(id) ON DELETE SET NULL,
  recurring_id TEXT REFERENCES recurring_transactions(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  payment_method TEXT,
  notes TEXT,
  reference TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS},
  CHECK (type <> 'transfer' OR (to_account_id IS NOT NULL AND to_account_id <> account_id))
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_type_date ON transactions(type, date);
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_to_account ON transactions(to_account_id);
CREATE INDEX IF NOT EXISTS idx_tx_category_date ON transactions(category_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_debt ON transactions(debt_id);
CREATE INDEX IF NOT EXISTS idx_tx_goal ON transactions(goal_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_recurring_occurrence ON transactions(recurring_id, date) WHERE recurring_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_tt_tag ON transaction_tags(tag_id);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  period TEXT NOT NULL CHECK (period IN ('weekly','monthly','custom')),
  limit_minor INTEGER NOT NULL CHECK (limit_minor > 0),
  start_date TEXT NOT NULL,
  end_date TEXT,
  alert_threshold REAL NOT NULL DEFAULT 0.8 CHECK (alert_threshold > 0 AND alert_threshold <= 1),
  archived INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);

CREATE TABLE IF NOT EXISTS budget_categories (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (budget_id, category_id)
);

CREATE TABLE IF NOT EXISTS debt_payments (
  id TEXT PRIMARY KEY NOT NULL,
  debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','penalty','adjustment')),
  amount_minor INTEGER NOT NULL,
  date TEXT NOT NULL,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS},
  CHECK (kind = 'adjustment' OR amount_minor > 0)
);
CREATE INDEX IF NOT EXISTS idx_debt_payments_debt ON debt_payments(debt_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_debt_payment_tx ON debt_payments(transaction_id) WHERE transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('debt','custom','bill','savings')),
  entity_id TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  offset_days INTEGER,
  date TEXT,
  time_of_day TEXT NOT NULL DEFAULT '09:00',
  repeat TEXT NOT NULL DEFAULT 'none',
  enabled INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);
CREATE INDEX IF NOT EXISTS idx_reminders_entity ON reminders(kind, entity_id);

CREATE TABLE IF NOT EXISTS financial_events (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bill','income','savings','note')),
  amount_minor INTEGER,
  notes TEXT,
  remind INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  ${TS}
);
CREATE INDEX IF NOT EXISTS idx_events_date ON financial_events(date);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_fired ON notifications(fired_at);

CREATE TABLE IF NOT EXISTS scheduled_notifications (
  key TEXT PRIMARY KEY NOT NULL,
  os_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_fire ON scheduled_notifications(fire_at);

CREATE TABLE IF NOT EXISTS exchange_rates (
  currency TEXT PRIMARY KEY NOT NULL,
  rate REAL NOT NULL CHECK (rate > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS health_snapshots (
  month TEXT PRIMARY KEY NOT NULL,
  total INTEGER NOT NULL,
  components TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export type ColumnType = 'text' | 'int' | 'real' | 'bool';

export interface TableSpec {
  name: string;
  /** Column → type & nullability. Used to validate/sanitise backup rows. */
  columns: Record<string, { type: ColumnType; nullable?: boolean; enum?: string[] }>;
  primaryKey: string[];
  /** Foreign keys (column → table) validated on restore. */
  references?: Record<string, string>;
  hasUpdatedAt: boolean;
}

const ts = { created_at: { type: 'text' as const }, updated_at: { type: 'text' as const } };
const demo = { is_demo: { type: 'bool' as const } };

/**
 * Tables included in backups, in dependency order (parents first).
 * notifications/scheduled_notifications are device-specific and excluded;
 * scheduling is rebuilt after restore.
 */
export const BACKUP_TABLES: TableSpec[] = [
  { name: 'preferences', primaryKey: ['key'], hasUpdatedAt: true, columns: { key: { type: 'text' }, value: { type: 'text' }, updated_at: { type: 'text' } } },
  {
    name: 'accounts',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    columns: {
      id: { type: 'text' },
      name: { type: 'text' },
      type: { type: 'text', enum: ['cash', 'bank', 'mobile_wallet', 'savings', 'business', 'other'] },
      currency: { type: 'text' },
      opening_balance_minor: { type: 'int' },
      color: { type: 'text', nullable: true },
      icon: { type: 'text', nullable: true },
      archived: { type: 'bool' },
      ...demo,
      ...ts,
    },
  },
  {
    name: 'categories',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    columns: {
      id: { type: 'text' },
      name: { type: 'text' },
      kind: { type: 'text', enum: ['income', 'expense'] },
      icon: { type: 'text' },
      color: { type: 'text' },
      is_system: { type: 'bool' },
      archived: { type: 'bool' },
      ...demo,
      ...ts,
    },
  },
  { name: 'tags', primaryKey: ['id'], hasUpdatedAt: true, columns: { id: { type: 'text' }, name: { type: 'text' }, ...demo, ...ts } },
  {
    name: 'debts',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    columns: {
      id: { type: 'text' },
      lender_name: { type: 'text' },
      debt_type: { type: 'text', enum: ['personal_loan', 'bank_loan', 'loan_app', 'family', 'friend', 'business', 'credit_purchase', 'other'] },
      currency: { type: 'text' },
      principal_minor: { type: 'int' },
      interest_type: { type: 'text', enum: ['none', 'fixed_amount', 'flat_percentage', 'simple_annual', 'reducing_balance', 'custom_schedule'] },
      interest_value: { type: 'real' },
      payment_frequency: { type: 'text', enum: ['one_time', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
      minimum_payment_minor: { type: 'int' },
      installment_count: { type: 'int' },
      start_date: { type: 'text' },
      first_due_date: { type: 'text' },
      end_date: { type: 'text', nullable: true },
      penalty_type: { type: 'text', enum: ['none', 'fixed', 'percentage'] },
      penalty_value: { type: 'real' },
      paid_before_minor: { type: 'int' },
      total_payable_override_minor: { type: 'int', nullable: true },
      notes: { type: 'text', nullable: true },
      status: { type: 'text', enum: ['active', 'paid_off', 'archived'] },
      ...demo,
      ...ts,
    },
  },
  {
    name: 'debt_schedule',
    primaryKey: ['id'],
    hasUpdatedAt: false,
    references: { debt_id: 'debts' },
    columns: { id: { type: 'text' }, debt_id: { type: 'text' }, due_date: { type: 'text' }, amount_minor: { type: 'int' } },
  },
  {
    name: 'savings_goals',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    references: { linked_account_id: 'accounts' },
    columns: {
      id: { type: 'text' },
      name: { type: 'text' },
      target_minor: { type: 'int' },
      currency: { type: 'text' },
      initial_minor: { type: 'int' },
      start_date: { type: 'text' },
      deadline: { type: 'text', nullable: true },
      linked_account_id: { type: 'text', nullable: true },
      icon: { type: 'text' },
      color: { type: 'text' },
      reminder_frequency: { type: 'text', enum: ['none', 'weekly', 'monthly'] },
      status: { type: 'text', enum: ['active', 'completed', 'archived'] },
      notes: { type: 'text', nullable: true },
      ...demo,
      ...ts,
    },
  },
  {
    name: 'recurring_transactions',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    references: { account_id: 'accounts', to_account_id: 'accounts', category_id: 'categories', debt_id: 'debts', goal_id: 'savings_goals' },
    columns: {
      id: { type: 'text' },
      type: { type: 'text', enum: ['income', 'expense', 'transfer', 'debt_repayment', 'savings_deposit', 'savings_withdrawal'] },
      amount_minor: { type: 'int' },
      account_id: { type: 'text' },
      to_account_id: { type: 'text', nullable: true },
      category_id: { type: 'text', nullable: true },
      debt_id: { type: 'text', nullable: true },
      goal_id: { type: 'text', nullable: true },
      description: { type: 'text' },
      payment_method: { type: 'text', nullable: true },
      frequency: { type: 'text', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'custom'] },
      interval: { type: 'int' },
      unit: { type: 'text', enum: ['day', 'week', 'month', 'year'] },
      start_date: { type: 'text' },
      end_date: { type: 'text', nullable: true },
      is_bill: { type: 'bool' },
      auto_create: { type: 'bool' },
      remind_days_before: { type: 'int' },
      last_generated_date: { type: 'text', nullable: true },
      active: { type: 'bool' },
      ...demo,
      ...ts,
    },
  },
  {
    name: 'transactions',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    references: {
      account_id: 'accounts',
      to_account_id: 'accounts',
      category_id: 'categories',
      debt_id: 'debts',
      goal_id: 'savings_goals',
      recurring_id: 'recurring_transactions',
    },
    columns: {
      id: { type: 'text' },
      type: { type: 'text', enum: ['income', 'expense', 'transfer', 'debt_repayment', 'loan_received', 'savings_deposit', 'savings_withdrawal'] },
      amount_minor: { type: 'int' },
      currency: { type: 'text' },
      base_amount_minor: { type: 'int' },
      fx_rate: { type: 'real' },
      date: { type: 'text' },
      time: { type: 'text', nullable: true },
      account_id: { type: 'text' },
      to_account_id: { type: 'text', nullable: true },
      to_amount_minor: { type: 'int', nullable: true },
      category_id: { type: 'text', nullable: true },
      debt_id: { type: 'text', nullable: true },
      goal_id: { type: 'text', nullable: true },
      recurring_id: { type: 'text', nullable: true },
      description: { type: 'text' },
      payment_method: { type: 'text', nullable: true },
      notes: { type: 'text', nullable: true },
      reference: { type: 'text', nullable: true },
      ...demo,
      ...ts,
    },
  },
  {
    name: 'transaction_tags',
    primaryKey: ['transaction_id', 'tag_id'],
    hasUpdatedAt: false,
    references: { transaction_id: 'transactions', tag_id: 'tags' },
    columns: { transaction_id: { type: 'text' }, tag_id: { type: 'text' } },
  },
  {
    name: 'budgets',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    columns: {
      id: { type: 'text' },
      name: { type: 'text' },
      period: { type: 'text', enum: ['weekly', 'monthly', 'custom'] },
      limit_minor: { type: 'int' },
      start_date: { type: 'text' },
      end_date: { type: 'text', nullable: true },
      alert_threshold: { type: 'real' },
      archived: { type: 'bool' },
      ...demo,
      ...ts,
    },
  },
  {
    name: 'budget_categories',
    primaryKey: ['budget_id', 'category_id'],
    hasUpdatedAt: false,
    references: { budget_id: 'budgets', category_id: 'categories' },
    columns: { budget_id: { type: 'text' }, category_id: { type: 'text' } },
  },
  {
    name: 'debt_payments',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    references: { debt_id: 'debts', transaction_id: 'transactions' },
    columns: {
      id: { type: 'text' },
      debt_id: { type: 'text' },
      kind: { type: 'text', enum: ['payment', 'penalty', 'adjustment'] },
      amount_minor: { type: 'int' },
      date: { type: 'text' },
      transaction_id: { type: 'text', nullable: true },
      notes: { type: 'text', nullable: true },
      ...demo,
      ...ts,
    },
  },
  {
    name: 'reminders',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    columns: {
      id: { type: 'text' },
      kind: { type: 'text', enum: ['debt', 'custom', 'bill', 'savings'] },
      entity_id: { type: 'text', nullable: true },
      title: { type: 'text' },
      message: { type: 'text' },
      offset_days: { type: 'int', nullable: true },
      date: { type: 'text', nullable: true },
      time_of_day: { type: 'text' },
      repeat: { type: 'text' },
      enabled: { type: 'bool' },
      ...demo,
      ...ts,
    },
  },
  {
    name: 'financial_events',
    primaryKey: ['id'],
    hasUpdatedAt: true,
    columns: {
      id: { type: 'text' },
      title: { type: 'text' },
      date: { type: 'text' },
      kind: { type: 'text', enum: ['bill', 'income', 'savings', 'note'] },
      amount_minor: { type: 'int', nullable: true },
      notes: { type: 'text', nullable: true },
      remind: { type: 'bool' },
      ...demo,
      ...ts,
    },
  },
  { name: 'exchange_rates', primaryKey: ['currency'], hasUpdatedAt: true, columns: { currency: { type: 'text' }, rate: { type: 'real' }, updated_at: { type: 'text' } } },
  {
    name: 'health_snapshots',
    primaryKey: ['month'],
    hasUpdatedAt: false,
    columns: { month: { type: 'text' }, total: { type: 'int' }, components: { type: 'text' }, created_at: { type: 'text' } },
  },
];

/** Tables whose rows carry an `is_demo` flag (used by "delete demo data"). */
export const DEMO_TABLES = [
  'transactions',
  'debt_payments',
  'recurring_transactions',
  'budgets',
  'debts',
  'savings_goals',
  'reminders',
  'financial_events',
  'tags',
  'categories',
  'accounts',
];
