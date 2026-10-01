# AGENTS.md

Guidance for AI coding agents (Claude Code, opencode, etc.) working on this repository. Claude Code
loads this file through `CLAUDE.md`; opencode reads it directly. Keep it up to date when the project
state or the conventions change.

## Project Overview

- **Platform**: Google Apps Script (GAS) project on the **V8 runtime** (`src/appsscript.json`, timezone `America/Santiago`), developed locally and deployed with **clasp** (`rootDir: src`).
- **Core function**: Automated expense ingestion from Chilean bank emails (BCI, Tenpo, MACH, Banco de Chile) and a Telegram bot into Google Sheets (`Transacciones`, `Diccionario`, `Logs`) and optionally Notion, categorized by a local dictionary and Google Gemini.
- **License**: Source-Available / Non-commercial (`src/LICENSE.js`). The repository owner is the author.
- **Docs**: `README.md` (architecture, setup, deploy, runbook), `docs/AUDITORIA.md` (audit findings and their status), `docs/ROADMAP.md` (prioritized future improvements).

## Current State (keep this section updated)

_Last update: 2026-09-30._

- **Branch**: work lives on `audit/hardening` (4 commits on top of `aef0158`). **Not merged into `main`** and **not deployed** to Apps Script yet. `main` still holds the pre-audit code.
  - `b275826` chore: tooling (clasp, ESLint, Prettier, tsc strict) and verification scripts
  - `3519e13` test: GAS harness and test suite
  - `0fe652d` fix(gemini): resilient cascade, id-based classifier, sweeper without nested locks
  - `3135fb6` refactor: move to `src/*.js`, Telegram/UI/parser hardening, documentation
- **Quality gate**: `npm run check` passes (syntax, Prettier, ESLint with `--max-warnings 0`, `tsc --strict`, 180 tests: 178 passing + 2 `todo`).
- **Deploy blocked on the user** (cannot be done by an agent): `npx clasp login`, enabling the Apps Script API, the `scriptId` (for `.clasp.json`, which is git-ignored) and the **existing** Web App `deploymentId`. After the first deploy the user must re-authorize once (explicit `oauthScopes`) and run the «🩺 Diagnóstico del sistema» menu.
- **Open items** (details in `docs/AUDITORIA.md` and `docs/ROADMAP.md`, "Ola 0"):
  - **F-PAR-1** (USD detected by substring anywhere in the email) and **F-PAR-2** (BCI "anulación" detected the same way): kept as `todo` tests on purpose. **Waiting for real, anonymized email samples from the user.** Do not change that detection logic without them.
  - Only **BCI** sends cancellation ("anulación") emails. Do not add cancellation handling for other banks unless the user asks.
  - Not verified live yet: the exact Gemini 3.x thinking parameter name (the client drops it automatically on HTTP 400), whether `LockService` is re-entrant (the code does not depend on it), and the new `oauthScopes`.
  - Deferred by decision: keeping the raw bank merchant text (F-CFG-3, needs a schema change) and unifying the Gmail query with `*_LOGIC.SUBJECTS` (F-CFG-5, would ingest new email types).
- **Next initiative**: a monthly spending dashboard reachable from a smartphone (data in Sheets and Notion). The research prompt was delivered in chat; nothing is implemented. See also `docs/ROADMAP.md`.

## Working Agreement for Agents

- **Language**: talk to the user in Spanish (Latin American). Code comments, JSDoc, log messages and UI/Telegram texts are in Spanish. Code identifiers keep their current names.
- **Plan first** for non-trivial changes and get the user's approval; ask before deciding anything that changes behavior visible to the user (schema, Gmail query, categories, Telegram texts).
- **Tests first**: reproduce a bug with a failing test before fixing it. Run `npm run check` before every commit; it must exit 0.
- **Git**: work on a feature branch, never commit directly to `main`. Make one commit per phase or topic using Conventional Commits in Spanish (`fix(gemini): …`, `test: …`). Never push, merge into `main`, run `clasp push` or `clasp deploy` without explicit user approval (`clasp push` overwrites the live project).
- **Secrets and data**: never read, print, change or commit Script Properties, API keys, tokens or `.clasp.json` contents. Never use real financial data in tests.
- **Keep docs in sync**: update this file ("Current State"), `docs/AUDITORIA.md` and `docs/ROADMAP.md` when a finding is fixed or a decision is taken.

## Code Structure & Global Scope

In GAS, all files in `src/` execute in a single **shared global namespace** (no ES modules, `import` or `export`). Files only contain declarations: no top-level code may depend on another file, so load order never matters (a test loads every file in isolation to enforce it).

- `appsscript.json`: Manifest (V8, timezone, explicit minimal `oauthScopes`, Web App `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS` required by the Telegram webhook).
- `types.js`: JSDoc `@typedef`s only (`Transaction`, `DictionaryEntry`, `ClassificationResult`, Gemini and Telegram shapes). No runtime code.
- `config.js`: `getEnv`/`setEnv`, `CONFIG` (sheets, headers, Gmail labels `LABEL_PROCESSED`/`LABEL_PARSE_ERROR`, `PENDING_CATEGORY`), bank regexes (`BCI_LOGIC`, `TENPO_LOGIC`, `MACH_LOGIC`, `BANCOCHILE_LOGIC`) and `MERCHANT_ALIASES` (first match wins; short aliases use letter lookarounds).
- `schema.js`: `TRANSACTION_FIELDS` (DTO field → sheet header, defines column order), `getTransactionColumns(headerRow)`, `transactionToRow`, `normalizeMerchantKey`.
- `utils.js`: Pure helpers (`formatClp`, `getErrorMessage`, `getErrorStack`).
- `extractor.js`: Gmail ETL (`processEmails`, `continueProcessEmails`). Guarded by the **user lock**. Order: parse → classify → save → label. Unreadable emails get `SaaS_Finanzas/Error_Parseo` plus an alert. Relays through a trigger after 3.5 minutes. Runs the sweeper at the end if time allows.
- `parser.js`: Router `parseBankEmail` (matches the sender **domain** and its subdomains) and one parser per bank. USD→CLP via `mindicador.cl` (logs a WARN when it falls back to 950 CLP).
- `gemini_client.js`: REST client. Paginated `ListModels`, numeric version ordering (stable flash → flash-lite → preview → pro only if `GEMINI_ALLOW_PRO=true`), per-model health in `CacheService`, retry on 503, wait on short 429, auth-failure cooldown keyed by an API-key hash, fallback list (`GEMINI_MODELS` or `GEMINI_SETTINGS.DEFAULT_MODELS`), API key only in the `x-goog-api-key` header. `callGemini` never throws.
- `classifier.js`: `classifyTransactions(items, {deadlineMs, ignoreCooldown})`: dictionary first, then Gemini in batches of 25 with numeric `id`s and `responseSchema`. Mutates items in place, supports partial success, never throws. Comment-based transfer classifications are not stored in the dictionary.
- `dao.js`: `getSheetOrThrow`, `withScriptLock`, `getExistingTransactionIds`, `getDictionaryMap`, `saveToDatabase` (idempotent by `ID_Unico`, dictionary upsert, Notion outside the lock), `deleteTransactionsByIds` (Sheets under lock, Notion after).
- `notion.js`: `pushToNotion`, `deleteTransactionInNotion`, `updateTransactionInNotion`; all requests go through `_notionRequest` (500 ms sleep, retry on 429 with `Retry-After`).
- `telegram.js`: `doPost` (secret token mandatory, only `TELEGRAM_CHAT_ID` is served), menu, manual expenses (classified like emails), `/borrar`, `notifyTransferRules`, `escapeTelegramHtml`, `sendTelegramMessage`, `sendTelegramAlert`.
- `logger.js`: `logSystemEvent(level, message, detail)` → `Logs` sheet; `ERROR` also alerts Telegram (detail truncated and HTML-escaped, 1 alert per message every 30 min, known secrets redacted).
- `maintenance.js`: Sweeper `retryUnclassifiedTransactions(options)` (read without lock → classify without lock → short locked write located by `ID_Unico` → Notion sync), nightly `cleanAndSortData` (sweeper, pending digest, sort, `Logs` pruning), `countPendingTransactions`. Never nests locks.
- `diagnostics.js`: `runDiagnostics` / `uiRunDiagnostics` (menu «🩺 Diagnóstico»): properties present (never values), sheets, label, triggers, model cascade, a real minimal Gemini call, lock re-entrancy probe.
- `triggers.js`, `setup.js`, `ui.js`: `uiSetupTriggers` (hourly `processEmails`, 2 AM `cleanAndSortData`), `installApp`, the `🤖 Asistente bancario` menu and wizards.

## Verification & Tooling

There is no local GAS runtime: `tests/harness/` loads `src/` into a single `vm` context, like Apps Script, and fakes the Google services. Requires Node ≥ 22.

```bash
npm install
npm run check                 # syntax (vm) + prettier + eslint + tsc (checkJs, strict) + tests
npm test                      # tests only
npm run test:coverage
npm run format                # always format through this script (see gotchas)
node scripts/todo-report.js   # which `todo` tests still fail, and which ones can be promoted
```

- **Types and docs**: every function needs JSDoc with typed `@param`/`@returns` (enforced by `eslint-plugin-jsdoc`); types are checked by `tsc --noEmit` in `strict` mode. Add shared shapes to `src/types.js`.
- **No test or debug code in `src/`** (it gets deployed). Tests live in `tests/`, excluded by `.claspignore` and `rootDir`.

### Test suite layout

- `tests/characterization/`: behavior preserved from the original code. If a change alters it on purpose, update the expectation and add a comment `// Cambio intencional (Fase N): …`.
- `tests/known-bugs/`: acceptance criteria for audit findings (IDs `RC*`, `F-*`). A test marked `{ todo: 'ID' }` documents a defect that still exists; when it is fixed, remove the `todo` (check with `scripts/todo-report.js`).
- `tests/*.test.js`: focused suites (Gemini client and classifier, hardening, diagnostics).

### Harness cheat sheet (`tests/harness/`)

- `createEnvironment(options)` (`load-gas.js`) returns `env`. Options: `props` (Script Properties), `gemini` (`false` or `{models, behaviors, classify, apiKey, pageSize, maxPageSize, listFails}`), `notion` (`true`/config), `lockReentrant`, `createSheets`, `files`.
- Call GAS code with `env.gas.call('fnName', ...args)`; read globals with `env.gas.get('CONFIG')`. Wrap results with `plain()` before `deepEqual` (objects come from another realm).
- Sheets: `env.tx`, `env.dict`, `env.logs` (`toObjects()`, `appendRow`, `select()`, `stats`), `env.logRows()`, `env.logsAt('ERROR')`, `env.allLogText()`.
- Gmail: `env.GmailApp.addThread([...])`, `labelsOf(thread)`, `_searches`, `failNextSearch(err)`. Email builders in `builders.js`; shortcuts in `scenarios.js` (`envWithLabel`, `addBciThread`, `addTxRow`, `failAll`).
- HTTP: `env.UrlFetchApp.addRoute({name, test, handle})` (later routes win), `callsTo(pattern)`, `onRequest` hook (inspect locks, mutate sheets mid-call). Exact Gemini error bodies from the incident: `geminiErrors` in `http-services.js`.
- Time and locks: `env.advance(ms)` (frozen clock; `Utilities.sleep` advances it), `env.LockService.setExternalHolder(true, 'script'|'user')`, `assertNoneHeld()`.
- `env.telegram.texts()`, `env.notion.active()`, `env.gemini.callCount`, `env.gemini.attemptedModels()`.
- The fake Gmail aborts after 60 searches per test ("BUCLE DESBOCADO") to stop runaway loops, because the clock does not advance on its own.

## Deploy (clasp)

`npm run check` → `npx clasp push` → `npx clasp version "…"` → `npx clasp deploy -i <existingDeploymentId>`. **Never create a new Web App deployment** (the Telegram webhook URL would change). Back up the remote project before the first push (`clasp pull` into a scratch folder + `clasp version`). Rollback: redeploy the previous version number. Full guide in `README.md`.

## Environment Variables (Script Properties)

Configured with `uiConfigWizard` / `uiConfigNotion` or `setEnv(key, value)`:

- `GEMINI_API_KEY`, `GEMINI_ANALYZE_TRANSFERS` (`'true'`/`'false'`, privacy toggle), `GEMINI_ALLOW_PRO` (`'true'` allows Pro models as last resort; there is no free-tier quota for Pro), `GEMINI_MODELS` (CSV fallback list).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (the only authorized chat), `TELEGRAM_SECRET_TOKEN` (required; the wizard generates a UUID if left empty), `WEB_APP_URL`.
- `NOTION_API_TOKEN`, `NOTION_DATABASE_ID`, `NOTION_ENABLED`.
- `INITIAL_BACKFILL_COMPLETED`: `'true'` / `'false'` (5 days vs 365 days Gmail window).

## Key Conventions & Gotchas

### Apps Script

1. **Global namespace**: never declare the same top-level name in two files (a test checks it). Private helpers start with `_`.
2. **Execution time**: GAS caps executions at 6 minutes. `extractor.js` stops at 3.5 minutes and relays; AI calls receive a `deadlineMs`.
3. **Locks**: wrap Sheets writes in `withScriptLock(timeout, fn)` with short critical sections. Never call something that takes the script lock while holding it, and never call Gemini or Notion inside a lock. `processEmails` guards itself with the **user** lock.
4. **No hardcoded column indexes**: use `getTransactionColumns(headerRow)` and locate rows by `ID_Unico`.
5. **Schema is pinned**: sheet names and headers are asserted by a test because Looker Studio and Notion depend on them. Changing them needs the user's approval.
6. **Failing AI must never lose data**: unclassified rows are saved as `CONFIG.PENDING_CATEGORY` and retried by the sweeper.
7. **Never log secrets**: always log through `logSystemEvent` (it redacts known credentials). The Gemini key travels only in a header.
8. **Syntax**: do not use `?.` or `??` in `src/` (ESLint blocks them; GAS V8 support is not guaranteed). Do not rely on `Intl` locales; use `formatClp`.
9. **CacheService** values live at most 6 hours (21600 s): longer cooldowns are not possible there.
10. **Gemini model IDs change often**: never hardcode a single model. Rely on discovery and keep `GEMINI_SETTINGS.DEFAULT_MODELS` as a reviewed fallback only.
11. In `doPost`, `e.parameter` is always an object and request headers cannot be read, which is why the webhook secret travels in the query string.
12. `insertCheckboxes` may make empty cells count as content: append to the dictionary using `_lastRowWithData(sheet, 1)`, not `getLastRow()`.

### Local environment (Windows)

- The repo lives in OneDrive; `node_modules/` is git-ignored but OneDrive still syncs it.
- Line endings are LF (`.gitattributes`, `.editorconfig`). Run Prettier through `npm run format` / `npm run format:check`: a bare `prettier --check .` silently skipped CRLF files.
- Both Git Bash and PowerShell are available. When writing commit messages from PowerShell, write them to a UTF-8 file **without BOM** and use `git commit -F <file>`; piping a string adds a BOM to the subject.
- `scratch/` is git-ignored and is the place for temporary outputs.
