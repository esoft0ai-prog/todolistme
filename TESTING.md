# Testing Finora

```bash
npm test               # all Jest suites
npm run test:ci        # CI mode with coverage report (coverage/)
npm run typecheck      # strict TypeScript over app + tests
```

Jest runs with the `jest-expo` preset. Integration tests use **Node's built-in SQLite** (`node:sqlite`, Node ≥ 22.5) through the same `SqlDriver` interface as the app, so the real schema, CHECK/FOREIGN KEY constraints, indexes, migrations and SQL queries are exercised — not mocks.

## Test suites

### Unit tests — `src/domain/__tests__`

| Suite | Covers |
|---|---|
| `money.test.ts` | Parsing (`25,000.50`, `₦1,200`, `25k`, `1.5m`, `2bn`), rejection of invalid/negative/too-precise/too-large input, formatting (grouping, signs, compact `150K`/`1.5M` incl. regression for trailing zeros), currency conversion across decimal places. |
| `dates.test.ts` | Leap years, month-end clamping, week starts (Mon/Sun), every dashboard period preset incl. invalid custom ranges, previous-period comparison, formatting & relative days. |
| `recurrence.test.ts` | Daily/weekly/bi-weekly/monthly/quarterly/yearly/custom rules, month-end anchors without drift, leap-day yearly rules, end dates, next occurrence, monthly equivalents. |
| `debt.test.ts` | All interest models (none, fixed, flat %, simple annual, amortised, custom schedule, override), instalment derivation, payment allocation, next payment, overdue detection, penalties, paid-before amounts, minimum-payment schedules, pace-based payoff projection, one-time monthly obligation, DTI, punctuality, validation, over-repayment prevention. |
| `budgetSavings.test.ts` | Calendar, salary-day and weekly budget periods, custom ranges, pace warnings ("exceeded in approximately 10 days"), threshold/exceeded/upcoming/ended states; goal progress, required weekly/monthly saving (rounded to whole units), on-track detection, completion, withdrawals, deadlines, validation. |
| `health.test.ts` | Each of the 5 components from known inputs (exact expected scores), neutral scores without data, penalties for heavy debt/overdue payments, change explanations, grades. |
| `planner.test.ts` | Debt reminders (before, on due date, overdue follow-ups, final payment wording, custom offsets & times), never scheduling in the past, paid-off debts, master switch & channel toggles, bills, savings, repeating custom reminders, backup nudge, ordering, schedule diffing (unchanged / cancelled / changed content). |
| `backup.test.ts` | Build/parse round trip, checksum, corrupt JSON, wrong format, newer versions, tampering detection, invalid enums/dates, broken references, duplicate ids, unknown columns (incl. SQL-looking column names), type normalisation, merge planning (newer edit wins, duplicates across devices with reference remapping, local preferences kept). |
| `cryptoExport.test.ts` | SHA-256 (NIST vectors + Node cross-check with Unicode), HMAC (RFC 4231), PBKDF2 vectors, hex helpers, constant-time compare; CSV escaping and formula-injection neutralisation; HTML report escaping + CSP. |
| `assistantParser.test.ts` | 18 intent classification cases (all example questions from the brief plus greetings/unknown), Nigerian amount formats, periods (last month, this year, last 3 months, month names), target dates, category synonyms (NEPA, okada, danfo, fuel…), goal matching. |

### Integration tests — `src/services/__tests__`

| Suite | Scenario |
|---|---|
| `ledger.test.ts` | Migrations apply/idempotent/refuse newer DB; DB constraints reject negative amounts & orphan rows. **Add/edit/delete transaction** with balances, tags and audit trail. Transfers excluded from income/expense. Cross-currency transfers & base-currency snapshots. Validation errors. **Duplicate detection** and override. Filtering, pagination, LIKE-escaping, SQL-injection strings, global search incl. amounts. Protected deletes of accounts/categories with re-assignment. **Add debt** with loan disbursement (not counted as income). **Record repayment** (from account / outside), automatic balance & status updates, over-repayment rejection, re-opening after deleting a payment, editing/deleting the repayment transaction, penalties & adjustments, deleting debts with/without transactions. **Budgets** from real spending with pace warnings. **Savings goals** deposits/withdrawals into linked account, over-withdrawal, completion. **Recurring** catch-up exactly once across restarts, projections, no unintended back-fill. |
| `system.test.ts` | **Notifications**: scheduling debt reminders, no duplicates on re-sync, **app restart** (fresh context, same DB and OS scheduler), **phone restart** where the OS lost all alarms, delivered notifications → history & unread count, cancelling after the debt is paid, permission denied / disabled / channel toggles, repeating custom reminders, budget alerts fired once per period. **Backup**: export → validate → **restore into a fresh install (replace)** with identical balances and transaction counts, device security preferences preserved; **merge** with cross-device duplicate detection; **atomic rollback** when a restore fails midway. **App lock**: PIN rules, salted PBKDF2 storage (PIN never stored), verification, **lockout persisting across restarts** and escalating, resume-lock rule, PIN length hint, DB key creation/reuse. **Demo data**: load, flagged rows, deletion that keeps real data and converts used demo accounts. **Assistant** end-to-end answers for all brief questions with calculation steps. **Dashboard** aggregate & health snapshot. |

## UI smoke test (browser)

The web build (`npx expo export --platform web`) swaps in a sql.js driver (`src/db/expoDriver.web.ts`), which lets a headless Chromium (Playwright) drive the real UI:

onboarding (currency, income, balance, skip optional steps, sample data) → dashboard → activity → plan (budgets, goals) → debts → debt detail → more → assistant (two questions) → reports → health → calendar → backup → settings → add a transaction through the form → verify it in the list → switch to light theme.

During development this run completed with **0 console errors and 0 page errors**; the screenshots it produced found and fixed three defects (compact money formatting `₦150K`→`₦15K`, low-contrast hero buttons, input overflow in the amount field).

## Device test checklist (manual, on a real phone)

Automated tests cannot cover OS-level behaviour. Before distributing a release, verify on at least one low-end (2–3 GB RAM, Android 8–10) and one recent phone (Android 13+):

1. Install the release APK by sideloading; open without SIM/Wi-Fi/data (airplane mode) — everything works.
2. Onboarding: allow notifications; set a PIN; enable fingerprint.
3. Add a debt due tomorrow with reminder "1 day before" at a time 2 minutes from now (Settings → Notifications → Default reminder time) → notification arrives with the app closed.
4. Swipe the app away from Recents → reminder still arrives. **Reboot the phone** → future reminders still arrive.
5. Lock: leave the app for longer than the auto-lock timeout → PIN required. Five wrong PINs → timed lockout that survives force-stop.
6. Recents thumbnail is blank; screenshots are blocked (when "Hide content" is on).
7. Export a JSON backup → share to WhatsApp/Drive; uninstall; reinstall; restore → data identical. Merge the same file again → duplicates skipped.
8. CSV opens in Google Sheets/Excel with ₦ intact; HTML report opens in a browser.
9. Change font size to largest in Android settings and enable "Larger text" → screens remain usable.
10. TalkBack: navigate tabs, add a transaction, read the dashboard.
11. `adb shell dumpsys package com.finora.app | grep permission` → no INTERNET permission in the release build.

## Adding tests

* Pure logic → `src/domain/__tests__/*.test.ts`.
* Anything touching SQL → use `setupTestContext()` from `src/test-utils/harness.ts` (fresh in-memory DB, migrations, default categories, controllable clock) and the fakes `FakeNotificationGateway` / `MemorySecureStore`.
