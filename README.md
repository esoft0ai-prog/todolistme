# Finora — Personal Finance & Debt Intelligence

Finora is an offline-first Android app for managing money: income, expenses, accounts, budgets, savings goals and — above all — **debts and loans**, with reminders that never depend on the internet. It was designed for Nigerian users (₦ by default, Nigerian spending patterns, loan-app style interest) but every calculation is currency-agnostic.

* **100 % offline.** No account, server, Firebase, cloud database, analytics or API. The release APK does not even request the `INTERNET` permission.
* **Private by design.** SQLCipher-encrypted database, key held in the Android Keystore, PIN/biometric app lock, screenshot protection.
* **Sideload-friendly.** Builds to a single APK you can copy to any Android 7.0+ phone, share over WhatsApp/Telegram, upload to Drive, GitHub Releases or a website.

---

## Contents

1. [Features](#features)
2. [Technology stack](#technology-stack)
3. [Project structure](#project-structure)
4. [Getting started (development)](#getting-started-development)
5. [Building the APK](#building-the-apk)
6. [Installing the APK on a phone](#installing-the-apk-on-a-phone)
7. [Database](#database)
8. [Backup & restore](#backup--restore)
9. [Notifications](#notifications)
10. [Security & privacy](#security--privacy)
11. [Testing](#testing)
12. [Troubleshooting](#troubleshooting)
13. [Known limitations](#known-limitations)
14. [Roadmap & extension points](#roadmap--extension-points)

More detail: [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE.md](DATABASE.md) · [SECURITY.md](SECURITY.md) · [TESTING.md](TESTING.md) · [BUILD_ANDROID.md](BUILD_ANDROID.md)

---

## Features

| Area | What you get |
|---|---|
| **Dashboard** | Total/spendable/savings balance, net worth, income, expenses, net cash flow, total debt, monthly debt obligation, budget remaining, upcoming payments and reminders, Financial Health Score. Periods: today, this week, this month, last month, last 3/6 months, this year, custom. Charts: income vs spending, cash flow, spending by category, debt reduction, savings progress. Every card is tappable. |
| **Transactions** | Income, expense, transfer, debt repayment, loan received, savings deposit, savings withdrawal. Amount, currency, date, time, category, description, account, payment method (incl. USSD/POS/mobile money), notes, reference, recurring, tags. Accidental-duplicate detection. Search, filters, pagination. |
| **Accounts / wallets** | Cash, bank, mobile wallet, savings, business, other — each with opening balance, live balance and currency. Transfers (including cross-currency) never count as income or spending. |
| **Categories** | Nigerian-friendly defaults (Food, Transport, Rent, Electricity, Internet, Education, Health, Family…), fully editable: create, rename, recolour, hide, delete (with re-assignment). |
| **Budgets** | Monthly (optionally anchored to salary day), weekly, custom date ranges; per category or all spending. Spent, remaining, % used, days remaining, daily pace, safe-to-spend per day, projected total, and early warnings: *"At your current spending rate, your Food budget may be exceeded in approximately 6 days."* |
| **Debts & loans** | Lender, type (bank, loan app, family, friend, credit purchase…), principal, current balance, interest (none, fixed amount, flat %, simple annual, reducing balance/amortised, custom schedule), frequency, minimum payment, dates, penalty terms, notes, status. Calculates outstanding balance, total payable, estimated interest, instalment schedule, next payment, days until due, payments remaining, overdue amount, debt-to-income ratio, monthly obligation, scheduled and pace-based payoff dates. Repayments update the balance automatically; penalties and manual adjustments supported. |
| **Debt reminders** | Per debt: 30/14/7/3/1 days before, on the due date, or any custom number of days, at a chosen time. Overdue follow-ups 1, 3, 7, 14 and 30 days after a missed payment. Final-payment reminders. |
| **Savings goals** | Target, saved, deadline, optional linked savings account. Percentage, remaining, required weekly/monthly saving, time-vs-money progress, current pace, on-track check, projected completion. |
| **Financial calendar** | Month grid with debt payments, bills, expected income, goal deadlines, budget resets, custom reminders and events; upcoming list; overdue section. |
| **Recurring transactions** | Daily, weekly, bi-weekly, monthly, quarterly, yearly or custom (every N days/weeks/months/years). Created automatically when due — including catch-up after days offline — exactly once. |
| **Financial Health Score** | 0–100 from five explained components (Savings, Debt burden, Budget discipline, Cash flow, Payment consistency — 20 points each) with tips, monthly history and "why your score changed". |
| **Financial assistant** | Local rule-based intent detection (no AI API) that answers "Can I afford a ₦100,000 phone?", "How much did I spend on food this month?", "When is my next debt payment?", etc., and shows *how it calculated* the answer. Understands ₦/N amounts, 25k/1.5m shorthand and Nigerian terms (NEPA/light, okada, danfo, data…). |
| **Reports** | Overview, income, expenses, cash flow, categories, debt, budgets, savings, monthly and yearly comparisons; filter by period, account and category; export as HTML report or CSV. |
| **Search** | Transactions (description, notes, tags, reference, amounts), debts, goals, accounts, categories, reminders and events — offline. |
| **Notifications** | Local, reboot-proof, per-category toggles, reminder time, history of delivered notifications, list of scheduled ones, budget warnings, savings and backup reminders. |
| **Backup & restore** | Full JSON backup, CSV export, HTML report; save to a folder or share. Restore with validation, integrity checksum, preview (date & record counts), confirmation, **replace** or **merge** (with duplicate detection) and automatic safety copies. |
| **Security** | App lock with PIN (PBKDF2) and fingerprint/face, auto-lock timeout, persistent brute-force lockout, hide-in-recents/screenshot blocking, encrypted database. |
| **Onboarding** | Currency, monthly income, starting balance, main goal, existing debts, notification permission, app lock — all skippable, no registration. |
| **Sample data** | One tap loads realistic, clearly labelled sample data; one tap removes it without touching your records. |
| **Accessibility** | Dark (default) and light themes, larger-text option plus system font scaling, screen-reader labels/roles on every control, 48 dp touch targets, clear error messages. |

## Technology stack

| Concern | Choice | Why |
|---|---|---|
| Framework | **React Native 0.86** (New Architecture, Hermes) via **Expo SDK 57** (bare/prebuild workflow) | Official RN framework; reproducible native project generation; no Expo Go or EAS needed. |
| Language | **TypeScript** (strict) | Types for every entity, service and screen. |
| Database | **expo-sqlite** with **SQLCipher** | Local relational DB, AES-256 encrypted at rest. |
| State | **Zustand** + a small `useQuery` hook | Tiny, predictable; the database is the source of truth. |
| Navigation | **React Navigation 7** (native stack + bottom tabs) | Native screens, low memory. |
| Notifications | **expo-notifications** (local only) | AlarmManager-based, persisted, re-armed after reboot/update. No FCM. |
| Secure storage | **expo-secure-store** (Android Keystore) | PIN hash, lockout state, DB key. |
| Biometrics | **expo-local-authentication** | Fingerprint / face unlock. |
| Files | **expo-file-system** (Storage Access Framework) + **expo-sharing** | Save/share/import without storage permissions. |
| Charts | Hand-written **react-native-svg** components | No chart library; fast on low-end phones. |
| Tests | **Jest** (jest-expo) with Node's built-in SQLite for real-SQL integration tests; Playwright UI smoke test on the web build | |

## Project structure

```
finora/
├── app.json                    # App config: name, package id, icons, splash, permissions, plugins
├── plugins/withFinoraAndroid.js# Android hardening: signing, offline release manifest, backup rules, exact alarms
├── index.ts                    # Entry point
├── assets/                     # Icon, adaptive icon layers, splash, notification icon
├── src/
│   ├── core/                   # App shell (App.tsx) and bootstrap (DB open, migrations, lock)
│   ├── domain/                 # Pure TypeScript business logic — no React, no I/O
│   │   ├── money.ts dates.ts recurrence.ts currency.ts validation.ts crypto.ts
│   │   ├── debt.ts budget.ts savings.ts health.ts reminderPlanner.ts
│   │   ├── backup.ts exporters.ts
│   │   └── assistant/ (parser.ts, engine.ts)
│   ├── db/                     # Schema + migrations, driver abstraction, expo & web drivers, row mappers
│   ├── services/               # Use-cases on top of the DB (transactions, debts, budgets, goals, recurring,
│   │                           # analytics, notifications, backup, security, demo, search, reports…)
│   ├── platform/               # Adapters for Expo native modules (notifications, secure store, files)
│   ├── state/                  # Zustand store, mutate() helper, useQuery hook
│   ├── navigation/             # Root stack + bottom tabs, typed routes
│   ├── screens/                # All screens, grouped by feature
│   ├── ui/                     # Theme, components (primitives, forms, charts, dialogs, PIN pad), labels
│   └── test-utils/             # Node SQLite driver + fakes for integration tests
└── .github/workflows/android.yml  # Optional CI that builds and publishes the APK
```

The `android/` folder is **generated** from `app.json` + `plugins/` by `npx expo prebuild` and is not committed (Continuous Native Generation). Everything that ends up in Gradle and `AndroidManifest.xml` is defined in version-controlled config.

## Getting started (development)

Requirements: **Node 20+**, **JDK 17 or 21**, **Android SDK** (platform 36, build-tools 36.0.0, NDK 27.1.12297006, CMake 3.22+/3.30), a phone with USB debugging or an emulator.

```bash
npm install
npm run typecheck        # TypeScript
npm test                 # 160+ unit & integration tests
npx expo prebuild -p android   # generates android/
npx expo run:android     # builds a debug app and starts Metro (hot reload)
```

`npm run web` starts a browser preview (uses an in-browser SQLite; notifications, biometrics and file sharing are no-ops there). It is used for automated UI smoke testing — the product target is Android.

## Building the APK

Full details, signing, versioning and ProGuard notes: **[BUILD_ANDROID.md](BUILD_ANDROID.md)**.

```bash
npm install
npx expo prebuild -p android --clean
cd android
./gradlew assembleRelease
```

**APK location:**

```
android/app/build/outputs/apk/release/Finora-1.0.0-release.apk
```

(A debug build — `./gradlew assembleDebug` — is written to `android/app/build/outputs/apk/debug/Finora-1.0.0-debug.apk`; it loads JavaScript from the Metro dev server and is meant for development.)

Release builds are signed with the key described in `android/keystore.properties` (never committed). Without it, Gradle prints a warning and signs with the debug key so you can still test.

## Installing the APK on a phone

1. Copy `Finora-1.0.0-release.apk` to the phone (USB, WhatsApp, Telegram, Bluetooth, Google Drive, email, a website or GitHub Releases).
2. Tap the file. Android asks to allow **"Install unknown apps"** for the app you opened it from (Files, Chrome, WhatsApp…). Allow it once.
3. Tap **Install**. Google Play Protect may say the app is from an unknown developer — choose **Install anyway** (it is simply not from the Play Store).
4. Open Finora. No internet or account is required.

Updating: install a newer APK **signed with the same key** over the old one — data is kept. An APK signed with a different key cannot update the app; you would have to uninstall first (export a backup before doing so!).

Minimum Android version: **7.0 (API 24)**. APK contains `armeabi-v7a` and `arm64-v8a` code (all real phones sold in the last decade).

## Database

Encrypted SQLite (SQLCipher) with 18 normalised tables — accounts, categories, transactions, tags, transaction_tags, budgets, budget_categories, debts, debt_schedule, debt_payments, savings_goals, recurring_transactions, reminders, financial_events, notifications, scheduled_notifications, exchange_rates, health_snapshots, audit_logs, preferences — with foreign keys, CHECK constraints, indexes and versioned migrations (`PRAGMA user_version`). Money is stored as integer minor units (kobo). Account balances are always *derived* from the ledger, never stored. See **[DATABASE.md](DATABASE.md)**.

## Backup & restore

* **Export**: *Settings → Backup & restore* → Full backup (JSON), Transactions (CSV, formula-injection safe), Financial report (HTML). Choose **Share** (WhatsApp, Drive, email…) or **Save to a folder**.
* **Import**: choose a `.json` backup → Finora validates structure, types, enums, dates, references and a SHA-256 checksum, shows the backup date and record counts, then asks **Merge** or **Replace** and confirms. A safety copy of current data is written first; the restore runs in a single transaction (all or nothing).
* **Merge** keeps the newest version of records with the same id and recognises duplicates entered separately on two phones (same transaction, same "Food" category, same account), remapping references.
* Security settings (PIN, app lock) are device-specific and never restored from a file.

## Notifications

All reminders are computed on the phone by a pure planner (`src/domain/reminderPlanner.ts`) and reconciled with Android's scheduler (`src/services/notifications.ts`) on start, resume, after every change and after restore — keyed and hashed so nothing is duplicated. expo-notifications stores them and re-arms them after **reboot** (`BOOT_COMPLETED`) and **app update**; they fire when the app is closed or swiped away. Exact alarms are used where permitted (`USE_EXACT_ALARM`). Six notification channels: debt payments, bills, budget warnings, savings, custom reminders, general. See [ARCHITECTURE.md](ARCHITECTURE.md#notification-engine).

## Security & privacy

* SQLCipher (AES-256) database; 256-bit random key in the Android Keystore.
* PIN stored only as salted PBKDF2-HMAC-SHA256 (10 000 iterations) in Keystore-backed storage; escalating lockout after 5 failures that survives restarts.
* Biometric unlock, auto-lock timeout, lock screen hides app content from screen readers, `FLAG_SECURE` (no screenshots / blank in recents).
* Release APK has **no INTERNET permission**, no analytics, no ads, no Firebase service; sensitive permissions (location, contacts, SMS, camera, microphone, storage) are explicitly blocked.
* Android backup and device-to-device transfer of app data are disabled.
* Parameterised SQL everywhere; backups validated against a column whitelist.

Full threat model and review: **[SECURITY.md](SECURITY.md)**.

## Testing

```bash
npm test            # all suites
npm run test:ci     # with coverage
npm run typecheck
```

160+ tests: money/dates/recurrence, debt interest models and schedules, budgets and pace warnings, savings goals, health score, notification planner, backup validation/merge, CSV/HTML exporters, crypto test vectors, assistant parsing — plus integration tests running the real schema on SQLite for transactions, debts, repayments, budgets, goals, recurring catch-up, notification scheduling across app/phone restarts, backup export/import/merge/rollback, app lock and sample data. See **[TESTING.md](TESTING.md)**.

## Troubleshooting

| Problem | Fix |
|---|---|
| "App not installed" | An app with the same package id but a different signing key is installed. Back up, uninstall the old one, install again. Or the APK is corrupt — re-download it. |
| "There was a problem parsing the package" | The phone runs Android < 7.0, or the file is incomplete. |
| Reminders late or missing | Allow notifications; set Finora's battery usage to **Unrestricted** (Tecno/Infinix/itel/Xiaomi/Samsung battery savers stop background alarms). *Settings → Notifications → Send test* checks delivery. |
| "Finora could not unlock its encrypted database" | The Keystore key was lost (e.g. the OS wiped credentials). Reset app data and restore a backup. |
| Build: `SDK location not found` | Create `android/local.properties` with `sdk.dir=/path/to/Android/sdk` or set `ANDROID_HOME`. |
| Build: NDK not found | Install NDK `27.1.12297006` via SDK Manager. |
| Release APK signed with debug key | Create `android/keystore.properties` (see BUILD_ANDROID.md). |

## Known limitations

* Exchange rates are entered manually (there is no rate feed offline).
* The assistant is rule-based: it understands the supported question types well but is not a general conversational AI.
* Data lives only on the device; losing the phone without a backup loses the data (by design — no cloud).
* The web preview is for development/testing only (no encryption, notifications or biometrics).
* iOS is not configured or tested (the code is cross-platform, but the product target is Android).

## Roadmap & extension points

The code is organised so these can be added without rewrites:

| Future feature | Extension point |
|---|---|
| Cloud sync / multi-device / web dashboard | UUID primary keys + `updated_at` on every row; the merge planner in `domain/backup.ts` already resolves conflicts; `SqlDriver` abstracts storage. |
| Optional user accounts | Preferences/device-local split in `services/backup.ts`; no code assumes a single anonymous user beyond preferences. |
| AI assistant | Implement `AssistantProvider` (`domain/assistant/engine.ts`) and reuse `AssistantDataSource`. |
| Bank statement import / open banking | Produce `TransactionInput`s and call `createTransaction` (validation, duplicate detection and FX handled). |
| Family / business finance | Add an owner/workspace column via a new migration; services already take a context object. |
| Investments / crypto | New account types + price table following the `exchange_rates` pattern. |
| Financial education | Health score tips are data-driven hooks. |
