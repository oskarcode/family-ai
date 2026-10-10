# Codebase Overview

## 1) Django/Python Mental Model

These are navigation aids, not exact framework equivalence.

| JS/TypeScript layer | Python/Django comparison | Repo evidence |
|---|---|---|
| Worker `fetch` entrypoint | `asgi.py` / application bootstrap | `src/ingest-worker/index.ts`, `src/worker/index.ts` |
| Hono route registration | Django `urls.py` / FastAPI router | `registerUploaderApi(...)` |
| Route or MCP callback | Django/FastAPI view | callbacks in `src/ingest-worker/server.ts` |
| Zod schema | Pydantic model / DRF serializer | MCP `inputSchema` and `outputSchema` |
| TypeScript `type` | `TypedDict`, dataclass intent, or type alias | `src/lib/types.ts` |
| Service helper | Python service function | `src/ingest-worker/ingestion.ts`, `buildUploadPlan(...)` |
| `package.json` | `pyproject.toml` plus task runner | root `package.json` |
| `package-lock.json` | Committed dependency resolution, like `poetry.lock` or `uv.lock` | root `package-lock.json` |
| Wrangler config | `settings.py` plus deploy manifest | `wrangler.jsonc`, `wrangler.ingest.jsonc` |
| D1 SQL migration | Django migration | `db/migrations/0001_initial.sql` |
| Vitest file | pytest module | `*.test.ts` |
| Worker binding | configured setting or injected client | `Env`, `EnvBindings`, Wrangler bindings |

## 2) System Context

- ChatGPT connects to `https://familymcp.oskarcode.com/mcp`, not directly to the Worker.
- Cloudflare MCP Portal can authenticate users and proxy the unified tool namespace; the upstream Worker still has its own optional Access-header check.
- `src/ingest-worker/index.ts` owns the Worker routes and transport lifecycle; the other `src/ingest-worker/*` modules own auth, schemas, search, and ingestion.
- `src/worker/index.ts` owns the separate core HTTP API.
- Managed AI Search is an internal dependency of the unified `search` tool.
- No browser frontend is present.

## 3) Repository Tree and File Categories

```text
src/ingest-worker/  application source: unified MCP
src/worker/         application source: core HTTP API
src/lib/            shared domain helpers and types
src/config/         file-processing policy
src/scripts/        operational CLI programs
db/migrations/      persistent D1 schema history
data/inventory/     operational inventory inputs for migration/report scripts
data/relationship_memory/ manually maintained family-note templates
test-fixtures/      repeatable test inputs
docs/               maintenance/learning documentation
outputs/            generated reports and run history
node_modules/       downloaded dependencies
.wrangler/          generated Wrangler local state
```

Unified MCP module map:

- `index.ts`: `/health` and `/mcp` routing plus MCP transport lifecycle.
- `server.ts`: eight MCP schemas, annotations, and tool callbacks.
- `ingestion.ts`: signed validation, R2 writes, conversion/splitting orchestration, and provenance.
- `cloudflare-api.ts`: Cloudflare conversion, AI Search item, sync, and status requests.
- `search.ts`: managed AI Search MCP request, source-prefix retrieval, SSE/JSON parsing, and category post-filtering.
- `deletion.ts`: guarded R2 object deletion plus best-effort AI Search item deletion.
- `auth.ts`: optional Access service-token checks and auth responses.
- `file-utils.ts`, `config.ts`, and `types.ts`: pure utilities, constants, and shared contracts.

Edit most often: `src/ingest-worker/`, `src/worker/`, `src/lib/`, `src/config/`, and `docs/`.

Do not normally edit: `node_modules/`, `.wrangler/`, `worker-configuration.d.ts`, historical `outputs/`, or applied SQL migrations.

## 4) Runtime Traffic Flow

- Input: MCP `tools/call`, core `/api/uploader/*` HTTP requests, or local migration commands.
- Orchestrator: `server.ts`, `ingestion.ts`, or `buildUploadPlan(...)`.
- Processing: the MCP path performs Zod validation, key generation, R2 writes, optional conversion/splitting, and AI Search submission. The separate core path performs uploader validation, R2 writes, D1 persistence, and a queue send.
- Output: MCP `structuredContent` plus R2/AI Search state, or core HTTP JSON plus R2/D1 state and a queue message. These are separate pipelines, not one transaction.

Search path:

1. `search` validates `query` and `ai_search_options` with Zod.
2. `searchFamilyDocuments(...)` calls the managed AI Search MCP.
3. Its SSE text payload is parsed into structured JSON.
4. The declared search `outputSchema` validates the response exposed to clients.
5. When a category filter is supplied, matching chunks are preferred by metadata or top-level object key; if no chunks match, the original result is returned instead of an empty answer.

Delete path:

1. `delete_file` validates `key_or_prefix`, `match`, `buckets`, `delete_ai_search_items`, and `confirm_delete` with Zod.
2. `deleteFamilyDocument(...)` rejects unsafe paths, wildcard-like keys, unconfirmed requests, and broad prefix deletes.
3. R2 artifacts are deleted from `family-raw`, `family-index-ready-v3`, or both.
4. Matching AI Search items for deleted index-ready keys are deleted only when direct Cloudflare API credentials are available.

Base64 upload path:

1. `validateFile(...)` creates a signed 10-minute preflight token.
2. `uploadAndIndex(...)` verifies token/file metadata equality.
3. Original and index-ready artifacts are written to R2.
4. AI Search item IDs are returned for `checkStatus(...)`.

ChatGPT file path:

1. `ingestChatGptFile(...)` receives an OpenAI file-param object with `download_url` and `file_id`.
2. It fetches the temporary HTTPS URL server-side, enforces the 10 MiB limit, and calls `uploadBytesAndIndex(...)`.
3. The shared byte pipeline writes `family-raw`, writes index-ready artifacts, and triggers AI Search.

Generated-text path:

1. `ingestGeneratedText(...)` requires a Markdown filename, non-blank `content_markdown`, and boolean `extraction_complete`.
2. It defaults `logical_folder` to `chat_sessions` and `doc_type` to `conversation_summary`; shared sanitizers default category/year/person/sensitivity to `general`/`unknown`/`shared`/`family`.
3. It creates its own signed preflight and calls `uploadAndIndex(...)`, so a configured `PREFLIGHT_SIGNING_SECRET` or fallback `ACCESS_CLIENT_SECRET` is required.
4. It records derived-text provenance: `source_kind: chat_extracted_document`, `original_preserved: false`, the extraction-completeness flag, and an optional original `source_filename`.

Core save path:

1. `buildUploadPlan(...)` validates confirmed multipart input and computes R2/D1 values.
2. `registerUploaderApi(...)` writes raw/index-ready R2 objects and inserts `documents` plus `document_versions` rows in D1.
3. It sends a follow-up message through `PROCESSING_QUEUE`. `wrangler.jsonc` declares a producer only, and this repository contains no queue consumer handler.

## 5) Hosting + Infra

- `family-ai-core`: configured by `wrangler.jsonc`; binds D1, three R2 buckets, and the producer side of a processing queue.
- Unified MCP runtime: deployed from `wrangler.ingest.jsonc`; binds `family-raw` and `family-index-ready-v3`.
- AI Search instance: `family-ai-chat-v3`, namespace `default` (`wrangler.ingest.jsonc`).
- Deploy commands: `npm run deploy:core` and `npm run deploy:ingest`.
- Worker types: generated by Wrangler into `worker-configuration.d.ts`.
- The core custom domain is `familyai.oskarcode.com`; updating its route requires API-token permission for the zone in addition to Workers script permissions.

## 6) Security + Auth

- Portal user auth: Cloudflare MCP Portal OAuth applies when clients enter through the Portal.
- MCP Worker auth: `auth.ts` checks Access service-token headers only when both `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` exist. Both absent means allow; exactly one means configuration error; both present with mismatched headers means `401`.
- Public MCP routes: `wrangler.ingest.jsonc` enables `workers_dev`; `/health` is always unauthenticated and `/mcp` is reachable on that public hostname subject only to the optional check above.
- Core API auth: none is implemented in `src/worker/index.ts` or `src/worker/uploaderApi.ts`. Its custom-domain routes are not protected by application code in this repository.
- Upload preflight: HMAC-signed `validation_id` from `createValidationId(...)` and `verifyValidationId(...)`.
- Secret names only: `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `CF_API_TOKEN`, `PREFLIGHT_SIGNING_SECRET`.
- Raw/index buckets are private bindings; no public bucket URL is used in application code.
- The Base64 upload tool accepts supplied encoded bytes and rejects path-like filenames.
- `delete_file` requires explicit confirmation, defaults to exact matching, caps prefix deletes at 100 objects, and refuses path traversal or wildcard-like keys.
- Original binary uploads may include `index_markdown_fallback` when a client has already extracted text. If Cloudflare `ai/tomarkdown` fails, the Worker still preserves the original bytes and indexes the fallback Markdown with explicit `fallback_markdown` mode.
- `ingest_chatgpt_file` is the ChatGPT-specific adapter for OpenAI file params. It receives `{ download_url, file_id, mime_type?, file_name? }`, fetches the temporary HTTPS URL server-side with the 10 MiB upload cap, and then uses the same byte ingestion path.

## 7) API Surface

Unified MCP tools registered in `src/ingest-worker/server.ts`:

- `family_ai_server_info`: identity, schema, and accepted upload fields.
- `search`: ranked private-document evidence.
- `delete_file`: confirmed duplicate/incorrect file deletion across R2 and optional AI Search items.
- `ingest_validate_file`: non-writing file preflight.
- `ingest_upload_validated_file`: R2 and AI Search write operation.
- `ingest_chatgpt_file`: ChatGPT file-param upload path for preserving attached originals without client-side `PUT`.
- `ingest_generated_text`: derived Markdown write operation for clients without original attachment bytes.
- `ingest_status`: read-only AI Search item status.

Supporting ingest Worker HTTP routes:

- `GET /health`: public service/version/tool-list status.
- `POST /mcp`: MCP protocol endpoint.

The current identity is MCP server version `1.5.1`, tool schema version `8`, and eight registered tools. The `family_ai_server_info.tools` array advertises all eight tools, including the discovery tool itself.

Core HTTP routes in `registerUploaderApi(...)`:

- `GET /api/uploader/options`
- `GET /api/uploader/documents`
- `GET /api/uploader/documents/:doc_id`
- `PATCH /api/uploader/documents/:doc_id`
- `POST /api/uploader/preview`
- `POST /api/uploader/save`

## 8) Data Model/Storage

- R2 `family-raw`: exact submitted payload bytes. For `ingest_generated_text`, this is derived Markdown rather than the unavailable original source.
- R2 `family-index-ready-v3`: direct or converted/split search artifacts.
- R2 `family-processed`: declared by the core Worker for later processed objects.
- D1 `documents`: classification, status, approval, and source metadata.
- D1 `document_versions`: R2 locations and lineage.
- D1 `processing_jobs`: background stage attempts/errors.
- D1 `index_events`: indexing outcomes.
- D1 `access_tags`: document-level key/value tags.

Category vocabulary is shared by both interfaces:

- `src/lib/categories.ts` defines canonical storage categories: `financial`, `medical`, `legal`, `immigration`, `home`, `employment`, `education`, `travel`, `relationship`, and `general`.
- `finance` and `health` are accepted only as upload aliases and normalize to `financial` and `medical`. `family` is retired and rejected as a category.
- Sensitivity and provenance contracts remain interface-specific. MCP sensitivity is `private | restricted | family`; core sensitivity is `restricted | family | shared`, and core can persist a `custom_category` label as `documents.subcategory`.
- A caller bridging the APIs must still map non-category metadata explicitly.

The canonical object path is built from category/year/person/document type/filename plus a checksum suffix. Changing `buildRawAndIndexKey(...)`, `uniqueKey(...)`, or classifier naming can affect deduplication and retrieval paths.

`src/scripts/cleanupLiveTaxonomy.ts` is the bounded repair command for reviewed legacy keys and duplicate AI Search built-ins. Its default mode is read-only; `--apply` is idempotent and verifies copied R2 objects before deleting source keys.

## 9) JS/TS Syntax Notes for Python Developers

- `type X = {...}`: compile-time shape, similar to `TypedDict`; it does not validate network input.
- Zod: runtime validation, similar to Pydantic/DRF serializers.
- `async function` / `Promise<T>`: `async def` and an awaited result.
- `import` / `export`: Python module imports and public names.
- `null`: explicit `None`; `undefined`: missing or not initialized.
- `value?.field`: safely read an optional value, similar to a guarded `getattr`.
- `value ?? fallback`: use fallback only for `null`/`undefined`, unlike Python `or` for every falsy value.
- `.map(...)`: list comprehension; `.filter(...)`: filtered comprehension; `.find(...)`: `next((x for ...), None)`.
- `{ filename, size_bytes }`: object destructuring by property name; similar to assigning named dictionary fields.
- `as const`: preserve literal values for stricter compile-time types.
- Union types such as `"queued" | "running"`: similar to Python `Literal` constraints.

## 10) Failure and Fallback Paths

- Invalid Access headers return `401` only when both Access secrets are configured; partial configuration returns `500`; no Access secrets means `/mcp` allows the request.
- Missing/invalid preflight token: upload returns a validation error and does not write.
- Preflight rejects unsafe names, unsupported extensions, and invalid/oversize sizes, but does not inspect `mime_type`; `uploadAndIndex(...)` performs extension/MIME compatibility checking during the write call.
- Direct AI Search upload failure: R2 artifacts remain and warnings describe sync fallback.
- Missing `CF_API_TOKEN`: R2 writes can succeed, but direct conversion/upload/status capabilities are unavailable.
- Search upstream failure or malformed SSE: `searchFamilyDocuments(...)` returns `success: false` with a parse/request error.
- Category-filtered search with no category-matching chunks: `searchFamilyDocuments(...)` preserves original AI Search results to avoid false-empty answers.
- Duplicate deletion without `CF_API_TOKEN`: R2 deletion can succeed, but AI Search item deletion returns a note and no direct search cleanup.
- Core save failure: inspect D1 batch, R2 writes, and the producer binding in `registerUploaderApi(...)`; do not assume a consumer exists in this repository.
