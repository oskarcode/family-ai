# Family AI

Family AI stores private family documents in Cloudflare R2, prepares searchable artifacts, and exposes one MCP server for search, safe ingestion, status checks, and guarded deletion of duplicate records.

## Start Here (Python/Django Mental Model)

These comparisons explain responsibility, not identical framework behavior.

| This project | Django/Python equivalent |
|---|---|
| `src/ingest-worker/index.ts` Worker `fetch` handler | `asgi.py` plus API views |
| `src/ingest-worker/server.ts` MCP tool registry | Django `urls.py` or FastAPI `APIRouter` |
| MCP tool callback | Django/FastAPI view function |
| Zod `inputSchema` / `outputSchema` | Pydantic model or DRF serializer |
| `src/worker/index.ts` Hono app | Small FastAPI/Django application bootstrap |
| `src/worker/uploaderApi.ts` | Django views plus service layer |
| TypeScript `type` | Python type hint, `TypedDict`, or dataclass intent |
| `package.json` | `pyproject.toml` plus command scripts |
| `package-lock.json` | Pinned dependency lockfile, comparable to a committed `poetry.lock` or `uv.lock` |
| `wrangler*.jsonc` | `settings.py` plus hosting manifest |
| `db/migrations/*.sql` | Django migrations |
| `*.test.ts` | pytest/Django test modules |

## What You Actually Maintain

1. `src/ingest-worker/`: unified MCP search, deletion, validation, upload, status, auth, and schemas.
2. `src/worker/`: non-frontend uploader and document metadata HTTP APIs.
3. `src/lib/` and `src/config/`: shared classification, names, types, and file policy.
4. `src/scripts/`: bulk migration and operational reports.
5. `wrangler*.jsonc` and `db/migrations/`: infrastructure bindings and D1 schema.

Usually do not edit `node_modules/`, `.wrangler/`, `worker-configuration.d.ts`, or `outputs/` by hand.

## What This Project Does

- Searches indexed family documents through the `search` MCP tool (`src/ingest-worker/search.ts`).
- Uses AI Search retrieval filters plus a local category safety filter so category-scoped searches return matching chunks when possible (`src/ingest-worker/search.ts`).
- Deletes exact duplicated or incorrect files from private R2 and matching AI Search items through the guarded `delete_file` MCP tool (`src/ingest-worker/deletion.ts`).
- Validates uploads before writing data with a signed `validation_id` (`src/ingest-worker/ingestion.ts`).
- Uploads ChatGPT attachments through OpenAI file params and generic MCP uploads through Base64 (`src/ingest-worker/ingestion.ts`).
- Stores submitted original payloads in R2 `family-raw` and index artifacts in `family-index-ready-v3`; generated-text payloads are derived Markdown, not preserved originals.
- Converts or splits supported files when they exceed the AI Search direct-upload limit (`src/ingest-worker/ingestion.ts`).
- Maintains document metadata through `/api/uploader/*` and D1 (`src/worker/uploaderApi.ts`).
- Supports repeatable bulk migration and reporting through `src/scripts/*`.
- Uses one storage taxonomy across both upload APIs: `financial`, `medical`, `legal`, `immigration`, `home`, `employment`, `education`, `travel`, `relationship`, and `general`.
- FamilyOS can front this MCP server through `family-os-mcp`; that companion gatekeeper optimizes Family AI search calls with the `typesafe/jev` model when its JEV secrets are configured.

## Architecture At A Glance

- **Public agent entrypoint:** Cloudflare MCP Portal at `https://familymcp.oskarcode.com/mcp`.
- **Unified MCP upstream:** Worker `/mcp` route in `src/ingest-worker/index.ts`; tool schemas and registrations live in `server.ts`.
- **Managed search source:** Cloudflare AI Search MCP, called by `searchFamilyDocuments(...)` in `search.ts`.
- **Deletion path:** `deleteFamilyDocument(...)` in `deletion.ts` deletes R2 artifacts and best-effort matching AI Search items.
- **Core HTTP API:** Hono Worker in `src/worker/index.ts` and `src/worker/uploaderApi.ts`.
- **MCP storage/indexing flow:** `src/ingest-worker/ingestion.ts` writes `family-raw` and `family-index-ready-v3`; `cloudflare-api.ts` submits AI Search items or starts a sync job. This flow does not use D1 or `PROCESSING_QUEUE`.
- **Core API persistence flow:** `src/worker/uploaderApi.ts` writes R2 plus D1, then sends one message to `PROCESSING_QUEUE`. This repository configures only the queue producer; no queue consumer is implemented or bound here.
- **Frontend:** none; the former uploader page was intentionally removed.

## Traffic Flow (Input -> Output)

### Search

1. ChatGPT calls portal tool `search`.
2. The portal authenticates the user and forwards the request to unified `/mcp`.
3. `searchFamilyDocuments(...)` calls the managed AI Search MCP.
4. The Worker converts text-wrapped JSON into validated MCP `structuredContent`.
5. ChatGPT receives ranked chunks, source keys, scores, metadata, and scoring details.

When a caller supplies `ai_search_options.retrieval.filters.category`, Family AI sends that filter to AI Search and then post-filters returned chunks by `item.metadata.category` or a matching object-key prefix. If no returned chunks match the category, the original result set is preserved to avoid false-empty answers.

### Delete Duplicate File

1. ChatGPT or another approved MCP client calls `delete_file` with a canonical `key_or_prefix` and `confirm_delete: true`.
2. The Worker rejects unsafe paths, missing confirmation, broad prefix deletes, and wildcard-like keys.
3. Exact deletes remove the object from `family-raw`, `family-index-ready-v3`, or both depending on `buckets`.
4. Prefix deletes list up to 100 narrow matches before deleting; broader matches are refused.
5. For deleted index-ready keys, the Worker best-effort deletes matching AI Search items when `CF_API_TOKEN` is configured.

### Upload

For ChatGPT attachments with OpenAI file-param support:

1. ChatGPT calls `ingest_chatgpt_file` with a `file` object containing `download_url`, `file_id`, and optional `mime_type`/`file_name`, plus classification metadata.
2. The Worker downloads the temporary `download_url` server-side with the normal 10 MiB cap.
3. The downloaded bytes go through the same storage/indexing path as every preserved-original upload.
4. The original file is stored in `family-raw`, index-ready artifacts are written to `family-index-ready-v3`, and AI Search upload/sync runs.
5. ChatGPT calls `ingest_status` with `ai_search_item_uploads[].id` when IDs are returned.

For Base64 original-file uploads fully inside MCP:

1. ChatGPT calls `ingest_validate_file` with user-provided file content or size.
2. The Worker checks the filename, extension, decoded or declared size, upload limit, and likely AI Search handling. Although `mime_type` appears in the preflight schema, `validateFile(...)` does not read it.
3. Validation returns a short-lived signed `validation_id`.
4. ChatGPT calls `ingest_upload_validated_file` with that token, Base64 file bytes, and metadata. If the client already extracted Markdown from a PDF/DOC, it can also pass `index_markdown_fallback`.
5. The Worker verifies the token, writes R2 objects, and submits AI Search items. If binary conversion fails and `index_markdown_fallback` is present, it preserves the original file and indexes the fallback Markdown with `mode: fallback_markdown`.
6. ChatGPT calls `ingest_status` with `ai_search_item_uploads[].id`.

For chat-generated or chat-extracted Markdown when original attachment bytes are unavailable:

1. ChatGPT calls `ingest_generated_text`. Required fields are `filename`, `content_markdown`, and boolean `extraction_complete`; `filename` must end in `.md` or `.markdown`, content must be non-blank, and the UTF-8 payload must be at most 10 MiB.
2. `source_filename` is optional and should name the unavailable original only when known. The normal classification fields are also optional.
3. `ingestGeneratedText(...)` defaults `logical_folder` to `chat_sessions` and `doc_type` to `conversation_summary`; shared upload defaults then supply `category: general`, `year: unknown`, `person: shared`, `sensitivity: family`, and `approved_by: current_user`.
4. The Worker internally creates a signed preflight, writes the derived Markdown through the same MCP R2/AI Search path, and never claims to preserve original bytes.
5. Result and R2 custom metadata record `source_kind: chat_extracted_document`, `original_preserved: false`, `extraction_complete`, and the source filename. The result uses `source_name`; R2 custom metadata uses `source_filename`.
6. ChatGPT calls `ingest_status` with any returned AI Search item IDs.

## Hosting and Deployment

- Runtime: Cloudflare Workers.
- Core API config: `wrangler.jsonc`.
- Unified MCP config: `wrangler.ingest.jsonc`.
- Environment currently declared by both configs: `dev`.
- Deploy core API: `npm run deploy:core`.
- Deploy unified MCP: `npm run deploy:ingest`.
- Generate Worker binding types: `npx wrangler types`.
- Validate a deployment without publishing: `npx wrangler deploy --dry-run --config wrangler.jsonc` or `npx wrangler deploy --dry-run --config wrangler.ingest.jsonc`.

The deployed Worker script retains the historical name `family-ai-ingest-mcp`, while its MCP server identity is `family-ai-mcp` version `1.5.1` with tool schema version `8` and eight registered tools (`config.ts` and `server.ts`).

## Security Model

- Portal boundary: Cloudflare MCP Portal can authenticate users before proxying requests, but that does not make the Workers routes private by itself.
- MCP Worker boundary: `/mcp` verifies `CF-Access-Client-Id` and `CF-Access-Client-Secret` only when both Worker secrets are configured. If both are absent, `isMcpRequestAuthorized(...)` deliberately allows the request; if only one is set, it returns `500`.
- Public Workers.dev exposure: `wrangler.ingest.jsonc` sets `workers_dev: true`. Both `/health` and `/mcp` therefore have a public Workers.dev route; `/health` never checks auth, and `/mcp` may be unauthenticated under the fail-open configuration above.
- Core API boundary: `src/worker/index.ts` and `registerUploaderApi(...)` install no authentication or authorization middleware. The custom-domain root, `/health`, and `/api/uploader/*` routes should be treated as publicly callable unless access is enforced outside this repository.
- Worker secret names: `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `CF_API_TOKEN`, and optional `PREFLIGHT_SIGNING_SECRET`.
- `CF_API_TOKEN` enables direct AI Search upload, status, conversion, and sync API calls.
- `ingest_chatgpt_file` fetches only the temporary HTTPS `download_url` supplied by ChatGPT's OpenAI file-param mechanism. The generic Base64 upload accepts supplied content through MCP, and generated-text ingestion accepts supplied Markdown.
- ChatGPT-style clients should prefer `ingest_chatgpt_file` when their connector supports `_meta["openai/fileParams"]`. If file params are unavailable, `ingest_upload_validated_file` is the MCP-native preserved-original path when `file_base64` is available; otherwise use `ingest_generated_text` for extracted text only.
- Never store real credentials in `.env.example` or documentation.

## APIs and Interfaces

### Unified MCP tools

| Tool | Purpose |
|---|---|
| `family_ai_server_info` | Proves server identity, schema version, and upload fields |
| `search` | Returns ranked evidence as structured output |
| `delete_file` | Deletes confirmed duplicate or incorrect R2 artifacts and best-effort AI Search items |
| `ingest_validate_file` | Preflights file type and size; returns `validation_id` |
| `ingest_upload_validated_file` | Writes a validated file and starts indexing; can use `index_markdown_fallback` if binary conversion fails |
| `ingest_chatgpt_file` | Downloads a ChatGPT file-param attachment server-side, preserves original bytes, and starts indexing |
| `ingest_generated_text` | Writes derived Markdown with explicit source-preservation and extraction provenance |
| `ingest_status` | Reads AI Search item state |

All eight MCP tools define both input and output schemas in `server.ts`. `family_ai_server_info.tools` advertises every registered tool, including `family_ai_server_info` itself.

### Supporting HTTP routes

| Route | Purpose |
|---|---|
| `GET /health` | Public service/version/tool-list health check |
| `POST /mcp` | MCP transport endpoint, protected by optional Access service-token headers |

### Category and metadata contracts

- `src/lib/categories.ts` is the shared category source of truth for MCP and core uploads. Canonical storage categories are `financial`, `medical`, `legal`, `immigration`, `home`, `employment`, `education`, `travel`, `relationship`, and `general`.
- Upload callers may still send historical aliases `finance` and `health`; both APIs normalize them to `financial` and `medical` before building storage keys. The retired `family` category is rejected rather than creating another top-level folder.
- Non-category metadata still differs by interface. MCP sensitivities are `private`, `restricted`, or `family` and include ingestion provenance; core sensitivities are `restricted`, `family`, or `shared`, and core allows a `custom_category` label persisted as D1 `documents.subcategory`.
- Do not copy non-category metadata values blindly between APIs. Translate them deliberately and validate against the receiving interface.

### Core uploader API

| Route | Purpose |
|---|---|
| `GET /api/uploader/options` | Allowed metadata options |
| `GET /api/uploader/documents` | Paginated document summaries |
| `GET /api/uploader/documents/:doc_id` | One document and versions |
| `PATCH /api/uploader/documents/:doc_id` | Metadata update |
| `POST /api/uploader/preview` | Preview upload plan without saving |
| `POST /api/uploader/save` | Persist file, metadata, and queue job |

## Frontend Overview

There is no frontend in this repository. `src/worker/index.ts` returns a JSON service message at `/`. Use ChatGPT through MCP or call `/api/uploader/*` programmatically.

## Quick Start

```bash
npm install
npm test
npx tsc --noEmit
npm run migrate:r2:dry
```

Example guarded duplicate deletion call through MCP:

```json
{
  "key_or_prefix": "medical/2026/kaitlin/birth_plan/duplicate.md",
  "match": "exact",
  "buckets": "both",
  "delete_ai_search_items": true,
  "confirm_delete": true
}
```

Useful report commands:

```bash
npm run report:upload-tracking
npm run report:indexing-status -- --instance family-ai-chat-v3
npm run report:search-validation -- --instance family-ai-chat-v3
npm run report:failed-file-mapping
npm run report:ops-status -- --instance family-ai-chat-v3
```

Guarded live-taxonomy cleanup defaults to a read-only plan. Apply mode copies each reviewed object, verifies size and ETag, deletes the old key, removes only provable duplicate AI Search built-ins, and starts an R2 sync:

```bash
npm run cleanup:taxonomy
npm run cleanup:taxonomy:apply
```

Apply-mode migration requires credentials configured from `.env.example`:

```bash
npm run migrate:r2:apply -- --raw-only
npm run migrate:r2:apply -- --index-only
```

## Repository Tree

```text
family_ai/
|-- src/
|   |-- ingest-worker/   # MCP entrypoint, tools, workflows, integrations, and tests
|   |-- worker/          # core HTTP API and tests
|   |-- lib/             # shared classification/types
|   |-- config/          # indexing policy
|   `-- scripts/         # migration and reports
|-- db/migrations/       # D1 schema history
|-- data/                # source inventories and curated family notes
|-- test-fixtures/       # ingestion scenarios
|-- docs/                # maintenance and learning guides
|-- outputs/             # generated operational reports
|-- wrangler*.jsonc      # Cloudflare deployment settings
`-- package.json         # dependencies and commands
```

Generated/downloaded directories:

- `node_modules/`: safe to delete; regenerate with `npm install`.
- `.wrangler/`: generated local Wrangler state, but deletion can erase local D1/R2/KV state used by `wrangler dev`. Delete it only when that data is disposable; Wrangler recreates an empty working area, not the lost local data.
- `outputs/`: generated by migration/report commands, but preserve historical reports unless intentionally rebuilding them.
- `worker-configuration.d.ts`: generated, but keep it because TypeScript checks include it; regenerate with `npx wrangler types`.

## Troubleshooting Jump Table

- Missing or stale ChatGPT tools: check `family_ai_server_info`, Portal sync, and `src/ingest-worker/index.test.ts`.
- Upload schema missing `validation_id`: verify ChatGPT uses `ingest_upload_validated_file`, not the retired tool name.
- Upload succeeds but search misses it: inspect `ai_search_item_uploads`, `warnings`, then call `ingest_status`.
- Category search returns unrelated evidence: inspect `ai_search_options.retrieval.filters`, `family_ai_category_filter_meta`, and `search.ts`.
- Duplicate delete only removed R2: verify `CF_API_TOKEN` is configured so `deletion.ts` can list and remove matching AI Search items.
- `401` from `/mcp`: inspect `src/ingest-worker/auth.ts` and Portal Access headers.
- API save failure: inspect `registerUploaderApi(...)`, D1 bindings, R2 bindings, and `PROCESSING_QUEUE`.
- Migration failure: inspect `src/scripts/migrateToR2.ts`, `.env`, and the selected manifest.

See `docs/TROUBLESHOOTING.md` for detailed checks.
