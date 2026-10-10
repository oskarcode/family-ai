# File Guide

## Critical Entrypoints

### `src/ingest-worker/index.ts`

- Role: thin Worker entrypoint for `/health`, `/mcp`, optional auth invocation, and MCP transport lifecycle.
- Django/Python equivalent: `asgi.py` plus top-level URL dispatch.
- Called by: Cloudflare Workers runtime through `wrangler.ingest.jsonc`.
- Calls into: `auth.ts`, `server.ts`, and the Agents SDK transport.
- Change risk: Medium.
- Edit when: changing Worker routes, health output, auth placement, or transport setup.
- If this breaks: inspect route matching, `isMcpRequestAuthorized(...)`, and `createMcpHandler(...)`.

### Unified MCP modules

| File | Owns | Edit when |
|---|---|---|
| `server.ts` | Eight MCP tool schemas, annotations, callbacks, and response wrapping | Changing the public MCP contract or tool registration |
| `ingestion.ts` | Signed preflight tokens, ChatGPT file download, validation, key creation, R2 writes, conversion/splitting orchestration, and provenance | Changing upload or generated-text behavior |
| `cloudflare-api.ts` | Cloudflare REST client, conversion formats/cache, AI Search upload, sync, and item status | Changing external Cloudflare API calls |
| `search.ts` | Managed AI Search MCP call, source-prefix retrieval, SSE/JSON parsing, and category post-filtering | Changing private-document retrieval |
| `deletion.ts` | Confirmed exact/prefix deletion for R2 objects and best-effort AI Search items | Changing duplicate-removal behavior |
| `auth.ts` | Optional Access service-token validation and auth responses | Changing MCP upstream authentication |
| `file-utils.ts` | Filename/MIME checks, encoding, HMAC, text splitting, and multipart construction | Changing low-level file handling |
| `config.ts` | Limits, server/schema versions, metadata enums, extension and MIME policy | Changing fixed MCP policy or advertised versions |
| `types.ts` | Worker bindings and shared workflow input/result contracts | Changing compile-time module contracts |

The MCP modules own the R2/AI Search flow, not the core D1/queue flow. Their imports are one-way: `index.ts` and `server.ts` depend on workflow/integration modules; workflow modules do not depend on the entrypoint or tool registry.

### `src/worker/index.ts`

- Role: core Hono Worker bootstrap and route registration. It installs no auth middleware.
- Django/Python equivalent: minimal `asgi.py` plus root `urls.py`.
- Called by: Cloudflare runtime through `wrangler.jsonc`.
- Calls into: `registerUploaderApi(...)`.
- Change risk: Low.
- Edit when: adding top-level health/service routes or another API module.
- If this breaks: inspect Hono construction, `registerUploaderApi(app)`, and default export.

### `src/worker/uploaderApi.ts`

- Role: upload preview/save, metadata reads/updates, file policy, R2/D1 persistence, and queue production.
- Django/Python equivalent: Django views plus service layer and ORM operations.
- Called by: `src/worker/index.ts`.
- Calls into: policy/classifier modules, D1, R2, and `PROCESSING_QUEUE.send(...)`. No queue consumer exists in this repository.
- Change risk: High.
- Edit when: changing HTTP upload behavior or document metadata APIs.
- If this breaks: inspect `readUploadInput(...)`, `buildUploadPlan(...)`, and the route near the failing URL.

## Feature/Domain Files

### `src/lib/classifier.ts`

- Role: category/person/year/document-type detection and canonical filenames/R2 keys.
- Django/Python equivalent: domain utility or classification service.
- Called by: migration planning, uploader API, and unified MCP upload.
- Calls into: string/path heuristics only.
- Change risk: High because key names and metadata can change.
- Edit when: adding classification rules or naming conventions.
- If this breaks: compare expected metadata and object keys in tests/reports.

### `src/lib/categories.ts`

- Role: shared canonical category list, historical upload aliases, and normalization used by MCP and core uploads.
- Canonical storage values: `financial`, `medical`, `legal`, `immigration`, `home`, `employment`, `education`, `travel`, `relationship`, and `general`.
- Input-only aliases: `finance` -> `financial` and `health` -> `medical`; `family` is rejected.
- Change risk: High because values become top-level R2 path segments and indexed metadata.

### `src/config/policy.ts`

- Role: decides `index_now`, `store_only`, conversion, OCR, review, or invalid-source status.
- Django/Python equivalent: policy/service module.
- Called by: uploader planning and migration planning.
- Calls into: shared types.
- Change risk: Medium/High.
- Edit when: accepted formats or size/media policy changes.
- If this breaks: inspect extension sets and `decideProcessingStatus(...)` branches.

### `src/lib/types.ts`

- Role: compile-time inventory, metadata, and status shapes.
- Django/Python equivalent: `TypedDict`/dataclass/type aliases, not Pydantic validation.
- Called by: scripts, policy, and uploader API.
- Calls into: nothing.
- Change risk: Medium.
- Edit when: domain fields or allowed status literals change.
- If this breaks: TypeScript errors show consumers that need updates.

## Migration and Reporting

### `src/scripts/generateMigrationPlan.ts`

- Role: reads inventory and creates migration manifests/backlogs.
- Django/Python equivalent: Django management command.
- Called by: `npm run plan:migration`.
- Calls into: classifier, policy, and shared types.
- Risk: Medium.
- If this breaks: inspect inventory input paths and generated manifest shape.

### `src/scripts/migrateToR2.ts`

- Role: copy-only bulk upload to raw/index-ready R2 with dry/apply modes.
- Django/Python equivalent: high-risk management command or data migration script.
- Called by: `npm run migrate:r2:dry` and `npm run migrate:r2:apply`.
- Calls into: R2 S3 API or Wrangler fallback.
- Risk: High.
- If this breaks: inspect `.env`, manifest paths, source root, mode flags, and concurrency.

### `src/scripts/cleanupLiveTaxonomy.ts`

- Role: guarded, explicit R2 key repair plus deletion of provable duplicate AI Search built-in items.
- Called by: `npm run cleanup:taxonomy` for a dry-run and `npm run cleanup:taxonomy:apply` for mutation.
- Safety: mappings are fixed in source; copy size and ETag are verified before source deletion; repeated apply runs report `already_moved`.
- Risk: High because apply mode mutates live R2 and AI Search state.

### Reporting scripts

- Files: `generateUploadTrackingReport.ts`, `generateIndexingStatusReport.ts`, `generateSearchValidationReport.ts`, `generateFailedFileMappingReport.ts`, `generateOperationalStatusReport.ts`.
- Django/Python equivalent: read-only management commands.
- Called by: `npm run report:*` scripts.
- Calls into: local manifests, reports, and Cloudflare APIs depending on script.
- Risk: Low/Medium because they report rather than mutate primary data.
- Edit when: report fields or operational checks change.
- If this breaks: inspect its input report/manifest and relevant credentials.

Specific ownership:

- `generateUploadTrackingReport.ts`: compares migration manifests and upload history; inspect `outputs/migration/` inputs first.
- `generateIndexingStatusReport.ts`: reads AI Search status for one instance; pass `--instance family-ai-chat-v3` because its standalone default is historical.
- `generateSearchValidationReport.ts`: runs queries from `docs/search_validation_queries.json`; pass `--instance family-ai-chat-v3`.
- `generateFailedFileMappingReport.ts`: maps indexing failures back to source inventory paths.
- `generateOperationalStatusReport.ts`: orchestrates the other reports and defaults to `family-ai-chat-v3`.

### Operational data inputs

- `docs/search_validation_queries.json`: validation query catalog used by `generateSearchValidationReport.ts`; edit when retrieval acceptance checks change; risk Low.
- `data/inventory/`: source inventory consumed by migration planning and reporting; edit/regenerate only when source-document inventory changes; risk Medium.
- `data/relationship_memory/`: manually maintained note/session templates; treat as family content, not generated output; risk Medium.
- `family_ai_planning.md`: historical design context; use current README/docs as operational truth and edit this file only when intentionally preserving planning history; risk Low.

## Infra/Config Files

### `wrangler.ingest.jsonc`

- Django/Python equivalent: `settings.py` plus deployment manifest for unified MCP.
- Controls: Worker entrypoint, R2 bindings, AI Search IDs, compatibility, observability.
- Exposure: `workers_dev: true` publishes `/health` and `/mcp` on the Workers.dev hostname; application auth for `/mcp` is optional when both Access secrets are absent.
- Risk: High; binding/config changes require redeployment.

### `wrangler.jsonc`

- Django/Python equivalent: `settings.py` plus deployment manifest for core API.
- Controls: public custom domain, D1, R2, queue producer, compatibility, observability. No application auth or queue consumer is configured here.
- Risk: High.

### `db/migrations/0001_initial.sql`

- Django/Python equivalent: initial Django migration.
- Controls: persistent D1 tables and indexes.
- Risk: High; do not rewrite after application without a new migration.

### `db/README.md`

- Django/Python equivalent: migration runbook beside a Django app's migrations.
- Called by: maintainers applying or inspecting D1 migrations.
- Risk: Low, but commands must stay aligned with `wrangler.jsonc`.

### `tsconfig.json`

- Django/Python equivalent: strict `mypy`/Pyright project configuration.
- Called by: `npx tsc --noEmit` and editor tooling.
- Controls: checked source paths, generated Worker declarations, module resolution, and no-output type checking.
- Risk: Medium; if this breaks, inspect Node/Workers type compatibility first.

### `.gitignore`

- Django/Python equivalent: repository ignore policy.
- Controls: local secrets, dependencies, Wrangler local state, and transient logs.
- Risk: High for secret safety; keep `.env.example` explicitly included.

### `package.json` and `package-lock.json`

- Django/Python equivalent: `pyproject.toml`/`requirements.txt` plus command aliases and pinned dependency resolution.
- Risk: Medium.
- Keep the lockfile; use npm commands rather than editing dependency internals.

### `vitest.config.ts`

- Limits the root suite to `src/**/*.test.ts`, preventing the separate nested `family-os` project from being collected by root `npm test`.
- Risk: Low; add another root test filename pattern here if the project adopts one.

### `.env` and `.env.example`

- Django/Python equivalent: environment-backed settings.
- `.env` is private and ignored; `.env.example` contains placeholders only.
- Never place secret values in docs, examples, Wrangler vars, or source code.

## Test and Fixture Files

### `src/ingest-worker/index.test.ts`

- Role: verifies unified manifest, output schemas, required upload fields, ChatGPT file-param ingestion, generated-text defaults/provenance and R2 writes, server info, and structured search conversion.
- Django/Python equivalent: pytest API/schema tests.
- Risk: Low; update when intentionally changing MCP contracts.

### `src/worker/uploaderApi.test.ts`

- Role: verifies uploader planning/policy behavior.
- Django/Python equivalent: Django service/view unit tests.
- Risk: Low.

### `test-fixtures/ingest-mcp/`

- Role: known file-format and size scenarios.
- Safe to edit: yes, when adding a scenario; preserve unique fixture tokens used for search checks.

### `test-fixtures/ingest-mcp/generate-large-fixtures.py`

- Role: deterministically regenerates the near-limit and over-limit text fixtures.
- Django/Python equivalent: test-fixture factory script.
- Regenerate: `python3 test-fixtures/ingest-mcp/generate-large-fixtures.py`.
- Risk: Low; changing sizes changes boundary-test meaning.

## Generated/Downloaded Files

### `node_modules/`

- Why it exists: installed npm dependencies.
- Safe to delete: yes.
- Regenerate: `npm install`.
- Edit manually: never.

### `.wrangler/`

- Why it exists: Wrangler local state/cache.
- Safe to delete: only when local development data is disposable. Deletion can remove local D1/R2/KV state, not just cache files.
- Regenerate: any `npx wrangler dev`, deploy, or related command recreates the directory, but cannot recover deleted local data.
- Edit manually: never.

### `worker-configuration.d.ts`

- Why it exists: generated Worker binding/runtime TypeScript declarations.
- Safe to delete: only if immediately regenerated; `tsconfig.json` includes it.
- Regenerate: `npx wrangler types --config wrangler.jsonc` for the core Worker declarations.
- Edit manually: never.

### `outputs/`

- Why it exists: generated migration/report results and run history.
- Safe to delete: not as a blanket rule. Preserve run history and manually resolved mappings; regenerate only reports whose source inputs still exist.
- Regenerate: relevant `npm run plan:migration`, `migrate:r2:*`, or `report:*` command.
- Edit manually: usually no.

## Quick Where-To-Look Map

- ChatGPT sees stale tools: `src/ingest-worker/index.test.ts`, `family_ai_server_info`, then Portal sync.
- Search result shape wrong: `src/ingest-worker/server.ts` and `search.ts`.
- Category-filtered search wrong: `search.ts` functions `getRequestedCategory(...)` and `applyCategoryResultFilter(...)`.
- Duplicate deletion wrong: `deleteFamilyDocument(...)` in `src/ingest-worker/deletion.ts`, then `listAiSearchItemsByKey(...)` and `deleteAiSearchItem(...)` in `cloudflare-api.ts`.
- Upload validation wrong: `validateFile(...)` in `ingestion.ts` and its Zod schema in `server.ts`.
- R2/indexing behavior wrong: `uploadAndIndex(...)` in `ingestion.ts`, then `cloudflare-api.ts`.
- ChatGPT file upload wrong: `ingestChatGptFile(...)` in `ingestion.ts`, plus its Zod schema and `_meta["openai/fileParams"]` in `server.ts`.
- Generated Markdown/provenance wrong: `ingestGeneratedText(...)`, then `uploadAndIndex(...)` in `ingestion.ts`.
- HTTP preview/save wrong: `buildUploadPlan(...)` and `registerUploaderApi(...)`.
- Metadata value rejected by one interface: compare MCP constants in `src/ingest-worker/config.ts` with core constants and `UploadInput` in `src/worker/uploaderApi.ts`; their vocabularies differ.
- Classification/key wrong: `src/lib/classifier.ts`.
- Bulk migration wrong: `src/scripts/migrateToR2.ts` and latest run report.
