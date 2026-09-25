# Finora — guidance for contributors and AI agents

Finora is an **offline-only** personal finance app for Android built with Expo SDK 57 (React Native 0.86, bare/prebuild workflow) and TypeScript.

## Non-negotiables

* **No network features.** No servers, Firebase, analytics, remote config, OTA updates or APIs. Release builds have no INTERNET permission — code that needs the network will not work.
* **Money is integer minor units** (`amountMinor`), dates are `YYYY-MM-DD` strings. Never use floats for stored money.
* **Balances are derived**, never stored. Don't add balance columns; change the ledger rules in `services/accounts.ts` if needed.
* **Schema changes = new migration** appended in `src/db/schema.ts` (+ update `BACKUP_TABLES` and `DATABASE.md`). Never edit shipped migrations.
* **SQL must be parameterised.** Column names may only come from static code.
* `android/` is generated (`npx expo prebuild -p android --clean`). Configure native behaviour in `app.json` or `plugins/withFinoraAndroid.js`, never by editing `android/`.

## Layout

`src/domain` (pure logic, no React/Expo imports) → `src/db` (schema, drivers) → `src/services` (use-cases, take a `ServiceContext`) → `src/state` (store, `mutate`, `useQuery`) → `src/screens` / `src/ui`. Platform modules are wrapped in `src/platform`. See ARCHITECTURE.md.

## Commands

```bash
npm run typecheck
npm test
npx expo prebuild -p android --clean && (cd android && ./gradlew assembleRelease)
npx expo export --platform web   # browser preview used for UI smoke tests
```

Use `EXPO_OFFLINE=1 npx expo install <pkg>` to add Expo-compatible native modules. Navigation uses React Navigation (not Expo Router). Builds are local Gradle or the GitHub Actions workflow (not EAS).

Run typecheck and tests before declaring work done; add tests for new domain logic (`src/domain/__tests__`) and SQL behaviour (`src/services/__tests__` with `setupTestContext()`).
