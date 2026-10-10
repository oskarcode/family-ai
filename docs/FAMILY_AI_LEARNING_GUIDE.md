# Family AI Learning Guide

## Quick Understanding
- What this repo does: Uploads/migrates family files to R2, prepares index-ready objects, exposes search through MCP, and deletes confirmed duplicate artifacts through a guarded MCP tool.
- Why it exists: Centralize family document retrieval with policy controls (no video/photo indexing by default).
- Main moving parts: migration scripts (`src/scripts/*`), uploader APIs (`src/worker/*`), and unified MCP modules (`src/ingest-worker/*`).

## Mental Model
- Input: local files (scripts), core API uploads (`/api/uploader/*`), or agent uploads (MCP tools).
- MCP pipeline: `ingestChatGptFile(...)`, `ingestGeneratedText(...)`, or `uploadAndIndex(...)` writes raw/index-ready R2 and then calls AI Search APIs. It does not write D1 or send queue messages.
- MCP deletion pipeline: `deleteFamilyDocument(...)` requires `confirm_delete: true`, deletes exact R2 keys or narrow prefixes, and best-effort deletes matching AI Search items.
- Core API pipeline: `buildUploadPlan(...)` and `registerUploaderApi(...)` write R2, persist D1 rows, and send a queue message. This repository has a producer binding but no queue consumer.
- Output: MCP search/index status or core HTTP/D1 status; these are separate operational views.

## Code Walkthrough (Evidence)
1. Entry point: `src/worker/index.ts`
   - Hono routes: `/health`, `/` (service message), then API registration.
2. Main flow: `src/worker/uploaderApi.ts`
   - `buildUploadPlan(...)` validates metadata, applies policy, computes keys, and decides indexing mode.
3. MCP flow: `src/ingest-worker/server.ts`, `ingestion.ts`, and `search.ts`
   - MCP tools: `family_ai_server_info`, `search`, `delete_file`, `ingest_validate_file`, `ingest_upload_validated_file`, `ingest_chatgpt_file`, `ingest_generated_text`, `ingest_status`.
   - Current server contract: version `1.5.1`, schema `8`, eight registered tools; server info advertises all eight.
   - `searchFamilyDocuments(...)` supports source-prefix retrieval, managed AI Search calls, and category post-filtering when AI Search returns mixed categories.
   - `deleteFamilyDocument(...)` enforces safe object-key deletion rules and uses Cloudflare AI Search APIs only when `CF_API_TOKEN` is configured.
   - `uploadAndIndex(...)` handles direct vs convert/split indexing and fallback behavior.
   - `ingestChatGptFile(...)` fetches ChatGPT temporary file-param URLs and sends those bytes through shared ingestion.
   - `ingestGeneratedText(...)` requires Markdown filename/content plus `extraction_complete`, defaults chat metadata, and records that original bytes were not preserved.
4. Integrations: `src/ingest-worker/cloudflare-api.ts`, `src/ingest-worker/search.ts`, `src/scripts/migrateToR2.ts`
   - R2 buckets, AI Search APIs, MCP transport, and S3-compatible uploads to R2.

## Learning Checkpoint
- Try this: upload `test-fixtures/ingest-mcp/01-indexable-basic.txt` via MCP ingest tool.
- Expected result: `ok: true`, item id returned, status progresses, token is searchable.
- If it fails, check: optional Access-header configuration, preflight signing secret, `CF_API_TOKEN`, and extension policy. Preflight does not inspect MIME; upload does.
- For ChatGPT attachments, prefer `ingest_chatgpt_file` when the connector supports OpenAI file params. For generic MCP clients, use `ingest_upload_validated_file` with Base64.
- If the client has already extracted Markdown from the original PDF/DOC, pass it as `index_markdown_fallback` on the original-file upload. That avoids the bad pattern where the original fails conversion and only a separate summary is searchable.
- Use `ingest_chatgpt_file` only when ChatGPT exposes a file object with a temporary `download_url`; otherwise use Base64 upload or derived Markdown.

## Change-Safety Notes
- If you modify key-building functions, verify dedupe/search recall.
- If you modify extension policy sets, verify preview + index outcomes.
- If you modify MCP auth logic, verify portal upstream header pass-through.
- If you modify ChatGPT file ingestion, verify file-param metadata, HTTPS-only download handling, and the 10 MiB cap.
- If you modify generated-text ingestion, verify provenance in both the tool result and R2 custom metadata.
- If you modify search, verify source-prefix mode, AI Search SSE parsing, and category-filter behavior.
- If you modify deletion, verify exact delete, prefix refusal thresholds, missing-object reporting, and AI Search deletion fallback when `CF_API_TOKEN` is absent.
- If you bridge core and MCP uploads, map metadata explicitly: their category and sensitivity vocabularies differ, and only MCP carries logical-folder/extraction provenance.
- If you modify security, remember the core API has no application auth and the Workers.dev MCP `/health` and `/mcp` routes are public; `/mcp` allows requests when both Access secrets are absent.
- Risk level: Medium.

## 30-60-90 Minute Study Plan
- 30 min: Read `README.md`, map pipelines.
- 60 min: Deep read `buildUploadPlan(...)` and `uploadAndIndex(...)`.
- 90 min: Run one migration dry-run and one MCP upload/status/search loop.

## Verify Understanding
- Commands:
  - `npm test`
  - `npx tsc --noEmit`
  - `npm run migrate:r2:dry`
  - `npm run deploy:ingest`
  - `npm run report:indexing-status -- --instance family-ai-chat-v3`
  - `npm run report:search-validation -- --instance family-ai-chat-v3`
  - `npm run report:ops-status -- --instance family-ai-chat-v3`
- 3 self-test questions:
  1) Where is direct vs converted indexing decided?
  2) How are key collisions prevented?
  3) Why can search succeed while status still shows `running`?

## Open Questions
- Needs verification: complete D1 mutation path coverage in uploader update APIs.
- Needs verification: edge MIME conversion behavior in `ai/tomarkdown` for uncommon docs.
