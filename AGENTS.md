# AGENTS.md

## Project Overview
- **Platform**: Google Apps Script (GAS) project on the **V8 runtime** (`appsscript.json`, timezone: `America/Santiago`).
- **Core function**: Automated financial expense ingestion from Chilean bank emails (BCI, Tenpo, MACH, Banco de Chile) and Telegram Bot into Google Sheets (`Transacciones`, `Diccionario`, `Logs`) and Notion, enriched with Google Gemini AI categorization.
- **License**: Source-Available / Non-commercial (`LICENCE.gs`).

## Code Structure & Global Scope
In GAS, all `.gs` files execute in a single **shared global namespace** (no ES modules, `import`, or `export`):
- `appsscript.json`: Manifest configuration (V8 runtime, timezone, web app permissions).
- `config.gs`: Environment access via `PropertiesService` (`getEnv`, `setEnv`), sheet constants (`CONFIG`), bank regex patterns (`BCI_LOGIC`, `TENPO_LOGIC`, etc.), and `MERCHANT_ALIASES` for entity resolution.
- `extractor.gs`: Gmail ETL engine (`processEmails`). Ingests bank threads, deduplicates via message IDs, and chains execution triggers if runtime exceeds 3.5 minutes.
- `parser.gs`: Bank router (`parseBankEmail`) and bank parsers (`parseBciEmail`, `parseTenpoEmail`, `parseMachEmail`, `parseBancoChileEmail`). Handles foreign currency (USD to CLP) via `mindicador.cl`.
- `gemini.gs`: AI categorization (`categorizeWithGemini`). Queries local dictionary cache first, then executes a resilient fallback cascade (`_fetchGeminiAPIWithCascade`) across dynamic Pro/Flash models and fallback endpoints.
- `dao.gs`: Data access layer for Google Sheets (`saveToDatabase`, `getExistingTransactionIds`, `deleteTransactionsByIds`). Uses `LockService.getScriptLock()` for concurrency control.
- `notion.gs`: Notion API client (`pushToNotion`, `deleteTransactionInNotion`). Uses `Utilities.sleep(500)` for strict rate limiting (<= 2 req/s).
- `telegram.gs`: Webhook handler (`doPost`), interactive inline keyboard menu, manual expense recording, batch deletion command (`/borrar <IDs>`), and transfer notifications (`notifyTransferRules`).
- `logger.gs`: Centralized log appender (`logSystemEvent`) writing to the `Logs` sheet and firing Telegram alerts on `ERROR`.
- `maitenance.gs` / `maintenance.gs`: Scheduled maintenance (`cleanAndSortData`) and unclassified transaction sweeper (`retryUnclassifiedTransactions`).
- `triggers.gs`: Time-driven triggers setup (`uiSetupTriggers` -> hourly `processEmails`, daily 2 AM `cleanAndSortData`).
- `setup.gs`: First-time setup orchestrator (`installApp`).
- `ui.gs`: Custom menu in Google Sheets (`🤖 Asistente bancario`) and interactive prompt wizards.

## Verification & Tooling
Because GAS APIs (`SpreadsheetApp`, `GmailApp`, `PropertiesService`, etc.) are hosted on Google's cloud infrastructure, there is no local GAS runtime:
- **Syntax Verification (Node.js)**: Validate syntax across all `.gs` files locally:
  ```powershell
  node -e "const fs = require('fs'), vm = require('vm'); fs.readdirSync('.').filter(f => f.endsWith('.gs')).forEach(f => { try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); console.log(f + ': OK'); } catch (e) { console.error(f + ': ERROR ' + e.message); process.exitCode = 1; } })"
  ```
- **Live Execution & Testing**: Test functions like `testGeminiIntegration()` directly in the Google Apps Script IDE / Script Editor console.

## Environment Variables (Script Properties)
Configured in `PropertiesService.getScriptProperties()` via `uiConfigWizard` / `uiConfigNotion` or `setEnv(key, value)`:
- `GEMINI_API_KEY`: API key for Google Gemini.
- `GEMINI_ANALYZE_TRANSFERS`: `'true'` / `'false'` (user privacy toggle for parsing transfer comment strings).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_SECRET_TOKEN`: Telegram bot credentials & webhook token validation.
- `WEB_APP_URL`: Google Apps Script deployed Web App URL for Telegram webhook.
- `NOTION_API_TOKEN`, `NOTION_DATABASE_ID`, `NOTION_ENABLED`: Notion integration toggle and credentials.
- `INITIAL_BACKFILL_COMPLETED`: `'true'` / `'false'` (switches Gmail search window from 365 days to 5 days).

## Key Operational Gotchas & Conventions
1. **Global Namespace Collisions**: Never declare conflicting top-level function or variable names across different files. Note: `maintenance.gs` and `maitenance.gs` contain duplicated/competing functions; prefer updating `maitenance.gs` (contains the active `retryUnclassifiedTransactions` implementation) or keeping them aligned.
2. **Execution Time Limit**: GAS has a strict 6-minute execution cap. `extractor.gs` bounds batch loops to 3.5 minutes (`MAX_EXECUTION_TIME`) and schedules `continueProcessEmails` via `ScriptApp.newTrigger` when backfilling.
3. **Concurrency & Locking**: Always wrap write operations to Sheets with `LockService.getScriptLock()` with a timeout (10-30s) and release inside a `finally` block (see `dao.gs`).
4. **Zero Hardcoding of Indexes**: In maintenance/sweeper operations, resolve column indexes dynamically from the header row (`headers.indexOf(...)`) instead of hardcoding column offsets.
5. **Notion Rate Limiting**: All Notion API operations must maintain throttling delays (500ms sleep) to avoid 429 rate limit errors during batch synchronization.
