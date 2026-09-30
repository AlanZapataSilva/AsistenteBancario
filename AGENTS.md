# AGENTS.md

## Project Overview

- **Platform**: Google Apps Script (GAS) project on the **V8 runtime** (`src/appsscript.json`, timezone: `America/Santiago`), developed locally and deployed with **clasp** (`rootDir: src`).
- **Core function**: Automated financial expense ingestion from Chilean bank emails (BCI, Tenpo, MACH, Banco de Chile) and Telegram Bot into Google Sheets (`Transacciones`, `Diccionario`, `Logs`) and Notion, enriched with Google Gemini AI categorization.
- **License**: Source-Available / Non-commercial (`src/LICENSE.js`).
- **Docs**: `README.md` (setup, deploy, runbook), `docs/AUDITORIA.md` (findings), `docs/ROADMAP.md` (opportunities).

## Code Structure & Global Scope

In GAS, all files in `src/` execute in a single **shared global namespace** (no ES modules, `import`, or `export`). Files only contain declarations: no top-level code may depend on another file, so load order never matters.

- `appsscript.json`: Manifest (V8 runtime, timezone, web app permissions).
- `types.js`: JSDoc `@typedef`s only (DTOs, Gemini and Telegram shapes). No runtime code.
- `config.js`: Environment access (`getEnv`, `setEnv`), `CONFIG` (sheets, headers, Gmail labels, `PENDING_CATEGORY`), bank regex patterns (`BCI_LOGIC`, `TENPO_LOGIC`, …) and `MERCHANT_ALIASES` (order matters: first match wins).
- `schema.js`: Maps DTO fields to sheet headers (`TRANSACTION_FIELDS`), resolves column positions from the header row (`getTransactionColumns`), `transactionToRow`, `normalizeMerchantKey`.
- `utils.js`: Pure helpers (`formatClp`, `getErrorMessage`, `getErrorStack`).
- `extractor.js`: Gmail ETL (`processEmails`, `continueProcessEmails`). Guarded by a **user lock**; order is parse → classify → save → label. Unreadable emails are labeled `SaaS_Finanzas/Error_Parseo`. Relays via trigger past 3.5 minutes.
- `parser.js`: Bank router (`parseBankEmail`, sender **domain** match) and parsers (`parseBciEmail`, `parseTenpoEmail`, `parseMachEmail`, `parseBancoChileEmail`); USD→CLP via `mindicador.cl`.
- `gemini_client.js`: REST client. Paginated `ListModels`, numeric version ordering, per-model health (circuit breaker in `CacheService`), retries, graceful degradation of optional params, API key in the `x-goog-api-key` header. Never throws on API failures (`callGemini` returns a result object).
- `classifier.js`: `classifyTransactions` (dictionary → Gemini in batches with numeric `id`s, structured output). Mutates items in place, returns a summary, never throws.
- `dao.js`: Sheets data layer (`saveToDatabase`, `deleteTransactionsByIds`, `getDictionaryMap`, `withScriptLock`, `getSheetOrThrow`). Idempotent inserts inside the script lock; Notion calls happen **outside** the lock.
- `notion.js`: Notion client (`pushToNotion`, `deleteTransactionInNotion`, `updateTransactionInNotion`). Every request sleeps 500 ms and retries on 429 honoring `Retry-After`.
- `telegram.js`: Webhook (`doPost`), menu, manual expenses, `/borrar`, notifications. Only the chat in `TELEGRAM_CHAT_ID` is served; the webhook secret is mandatory.
- `logger.js`: `logSystemEvent` → `Logs` sheet; `ERROR` also alerts Telegram (detail included, HTML-escaped, throttled to 1 per message / 30 min, secrets redacted).
- `maintenance.js`: Sweeper (`retryUnclassifiedTransactions`), nightly `cleanAndSortData`, pending digest. **Never nests locks.**
- `diagnostics.js`: `runDiagnostics` (menu «🩺 Diagnóstico»): config check + real minimal Gemini call.
- `triggers.js`, `setup.js`, `ui.js`: triggers (`uiSetupTriggers`), first-time setup (`installApp`), custom menu and wizards.

## Verification & Tooling

There is no local GAS runtime; `tests/harness/` loads `src/` into one `vm` context and fakes the Google services.

```bash
npm install
npm run check          # syntax (vm) + prettier + eslint + tsc (checkJs, strict) + tests
npm test               # tests only
node scripts/todo-report.js   # known defects still failing (`todo` tests)
```

- **Types/docs**: every function needs JSDoc with types (`@param {T} name - …`, `@returns`). `tsc --noEmit` runs in `strict` mode over `src/`. Write comments and messages in Spanish.
- **Tests**: `tests/characterization/` (behavior preserved from the original), `tests/known-bugs/` (acceptance criteria; a test marked `todo` still fails), plus focused suites. No test or debug function may live in `src/`.
- **Live check** after a deploy: menu «🩺 Diagnóstico del sistema».

## Deploy (clasp)

`npm run check` → `npx clasp push` → `npx clasp version "…"` → `npx clasp deploy -i <existingDeploymentId>`. **Never create a new Web App deployment** (the Telegram webhook URL would change). `clasp push` overwrites the remote project; back it up first (`clasp pull` + `clasp version`). See `README.md`.

## Environment Variables (Script Properties)

Configured with `uiConfigWizard` / `uiConfigNotion` or `setEnv(key, value)`:

- `GEMINI_API_KEY`, `GEMINI_ANALYZE_TRANSFERS` (`'true'`/`'false'`, privacy toggle), `GEMINI_ALLOW_PRO` (`'true'` allows Pro models as last resort), `GEMINI_MODELS` (CSV fallback list).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (the only authorized chat), `TELEGRAM_SECRET_TOKEN` (required), `WEB_APP_URL`.
- `NOTION_API_TOKEN`, `NOTION_DATABASE_ID`, `NOTION_ENABLED`.
- `INITIAL_BACKFILL_COMPLETED`: `'true'` / `'false'` (365 days vs 5 days Gmail window).

## Key Operational Gotchas & Conventions

1. **Global namespace**: never declare the same top-level name in two files (`tests/known-bugs/parser-config-structure.test.js` checks it). Private helpers start with `_`.
2. **Execution time limit**: GAS caps executions at 6 minutes. `extractor.js` stops at 3.5 minutes and schedules `continueProcessEmails`; the AI calls take a `deadlineMs`.
3. **Locks**: wrap Sheets writes with `withScriptLock(timeout, fn)` (short critical sections). **Never call a function that takes the script lock while holding it**, and never call Gemini or Notion inside a lock. It is not documented whether `LockService` is re-entrant; the code must work either way (`processEmails` uses the _user_ lock as its own guard).
4. **No hardcoded column indexes**: resolve them from the header row (`getTransactionColumns`), locate rows by `ID_Unico`, not by remembered row numbers.
5. **Notion rate limiting**: all Notion requests go through `_notionRequest` (500 ms sleep, retry on 429).
6. **No schema changes** without updating Looker Studio and Notion: the sheet headers are pinned by a test.
7. **Never log secrets**: use `logSystemEvent` (it redacts known credentials); the Gemini key travels only in a header.
8. **Failing AI must never lose data**: unclassified transactions are saved as `CONFIG.PENDING_CATEGORY` and retried by the sweeper.
