# Troubleshooting

## Symptom -> First Checks

### ChatGPT shows old or missing tools

- Call `family_ai_server_info`; expect service `family-ai-mcp`, version `1.5.1`, and schema version `8`.
- Expect eight registered tools total. The `tools` field returned by `family_ai_server_info` lists all eight, including `family_ai_server_info` itself and `delete_file`.
- Confirm the Portal contains only the unified upstream `/mcp` server.
- In Cloudflare Zero Trust, sync MCP server capabilities.
- Reconnect the ChatGPT app and start a new conversation.
- Run `npm test`; `src/ingest-worker/index.test.ts` asserts the source manifest.

### Upload tool omits `validation_id` or `logical_folder`

- Confirm the tool is `ingest_upload_validated_file`; the retired upload name must not be used.
- `validation_id` is required; `logical_folder` is optional with six enum values.
- Inspect the upload `inputSchema` in `src/ingest-worker/server.ts`.
- Use `family_ai_server_info.required_upload_fields` and `.optional_upload_fields` as a client-visible check.

### `/mcp` returns `401 Unauthorized`

- A `401` is possible only when both Access secrets are configured.
- Confirm Portal upstream headers include `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- Confirm Worker secrets `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` are both set.
- Inspect `isMcpRequestAuthorized(...)` in `src/ingest-worker/auth.ts`.
- Do not place the credentials in source, docs, or `.env.example`.

### `/mcp` returns auth-misconfigured `500`

- Exactly one Access secret is set on the Worker.
- Set both `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`, or remove both. Removing both is fail-open for every `/mcp` request, including the public Workers.dev route, not merely a local-development behavior.

### Core `/api/uploader/*` can be called without credentials

- This is current behavior, not an auth-header troubleshooting problem: `src/worker/index.ts` and `registerUploaderApi(...)` contain no auth middleware.
- The custom-domain root, `/health`, and uploader routes are exposed unless an external Cloudflare control not represented in this repository protects them.
- Do not document or assume Portal OAuth protects the core API.

### Validation succeeds but upload rejects `validation_id`

- Tokens expire after about 10 minutes; rerun `ingest_validate_file`.
- Filename and decoded byte size must exactly match the preflight call.
- Inspect `createValidationId(...)` and `verifyValidationId(...)` in `src/ingest-worker/ingestion.ts`.
- Confirm `PREFLIGHT_SIGNING_SECRET` or fallback `ACCESS_CLIENT_SECRET` is configured.

### Original PDF upload fails during conversion

- If the client already extracted the PDF text, retry the original-file ingestion with `index_markdown_fallback` instead of saving only a separate summary.
- `index_markdown_fallback` keeps `original_preserved: true`, stores the original PDF in `family-raw`, and writes searchable Markdown to `family-index-ready-v3` with `mode: fallback_markdown` when `ai/tomarkdown` fails.
- This is different from `ingest_generated_text`, which stores only derived Markdown and records `original_preserved: false`.
- If no fallback text is available, the upload returns `ok: false` with `raw_key` and a conversion error; preserve that error for troubleshooting.

### Chat client cannot access original attachment bytes

- For ChatGPT, first try `ingest_chatgpt_file`. It requires ChatGPT Apps SDK file-param support and a `file` object with `download_url` and `file_id`.
- `ingest_chatgpt_file` downloads only HTTPS temporary file URLs server-side, then preserves the original bytes through the shared R2/AI Search pipeline.
- If the client can provide `file_base64`, use `ingest_validate_file` and `ingest_upload_validated_file`; that is the generic MCP-native preserved-original upload path.
- If neither file params nor Base64 bytes are available, use `ingest_generated_text` with extracted Markdown instead of fabricating a binary upload.
- Supply all required fields: a `.md`/`.markdown` `filename`, non-blank `content_markdown`, and boolean `extraction_complete`.
- Set `source_filename` only when the original filename is known.
- Set `extraction_complete` honestly; incomplete extraction is stored and returned as a warning.
- The resulting metadata must report `source_kind: chat_extracted_document` and `original_preserved: false`.
- Expected defaults are `logical_folder: chat_sessions`, `doc_type: conversation_summary`, `category: general`, `year: unknown`, `person: shared`, `sensitivity: family`, and `approved_by: current_user`.

### `ingest_generated_text` says validation signing is not configured

- Generated text creates its preflight internally, but still needs a signing secret.
- Configure `PREFLIGHT_SIGNING_SECRET`, or configure `ACCESS_CLIENT_SECRET` as the fallback used by `getSigningSecret(...)`.
- This can occur even while `/mcp` is reachable, because MCP auth fails open when both Access secrets are absent but preflight signing does not.

### `ingest_generated_text` rejects the input

- `filename` must end in `.md` or `.markdown` and cannot contain path-like segments.
- `source_filename`, when supplied, also cannot contain path-like segments.
- `content_markdown` must remain non-empty after trimming and encode to no more than 10 MiB.
- If the write succeeds but indexing is delayed, inspect `warnings`, `ai_search_item_uploads`, and `sync_job`, then call `ingest_status`.

### Upload succeeds but search finds nothing

- Read `warnings` and `ai_search_item_uploads` from `ingest_chatgpt_file`, `ingest_upload_validated_file`, or `ingest_generated_text`.
- Call `ingest_status` with each `ai_search_item_uploads[].id`.
- Check whether status is still `queued` or `running`.
- Confirm `CF_API_TOKEN`, `AI_SEARCH_INSTANCE_ID`, and `AI_SEARCH_NAMESPACE` on the deployed Worker.
- Run the commands with the deployed instance explicitly: `npm run report:indexing-status -- --instance family-ai-chat-v3` and `npm run report:search-validation -- --instance family-ai-chat-v3`.

### Search validation report returns authentication error 10000

- `generateSearchValidationReport.ts` invokes the account-level AI Search search API through Wrangler. The active API token must include permission for that operation; R2 or AI Search item-management access alone is not sufficient.
- This does not prove the deployed MCP `search` tool is failing. Validate through the authenticated Portal path or call the Worker `/mcp` route with its configured Access service-token headers.
- A direct `/mcp` smoke test without those headers should return `401` when MCP Access secrets are configured; `/health` remains public.

### Search returns an error or malformed output

- Inspect `searchFamilyDocuments(...)` in `src/ingest-worker/search.ts` for request/SSE parsing errors.
- Check the managed AI Search MCP endpoint and instance health.
- Confirm client options use `ai_search_options.retrieval.match_threshold`, not the retired `ranking_options.score_threshold` shape.
- Run the structured-search test in `src/ingest-worker/index.test.ts`.

### Category search returns unrelated evidence

- Confirm the caller is using the documented AI Search shape: `ai_search_options.retrieval.filters.category` or an equivalent category filter accepted by `search.ts`.
- Inspect `family_ai_category_filter_meta` in successful responses. Its presence means Family AI trimmed mixed-category chunks after AI Search returned them.
- If the field is absent, AI Search either already returned only matching chunks, no category filter was supplied, or no returned chunks matched the requested category and Family AI preserved the original result to avoid a false-empty answer.
- For FamilyOS-initiated searches, inspect `family-os/cloudflare-os/packages/mcp-shared/src/family-search-optimizer.ts` and the `family-search.optimize.applied` log event.

### `delete_file` does not remove AI Search results

- R2 deletion can succeed without `CF_API_TOKEN`, but direct AI Search item deletion cannot.
- Inspect the tool response `notes` and `ai_search_errors` fields.
- Exact deletion only attempts AI Search cleanup for deleted `index_ready` keys. If you delete only `raw`, no AI Search item should be removed.
- Prefix deletes are intentionally capped at 100 objects and require at least 12 characters in `key_or_prefix`; use a narrower prefix for large duplicate sets.

### Preview says file is not indexable

- Inspect preview fields `blocked_reason`, `indexing_mode`, and `indexing_note`.
- Check extension/media rules in `src/config/policy.ts`.
- Check `AI_SEARCH_MAX_BYTES` in `src/ingest-worker/config.ts` and conversion logic in `ingestion.ts` and `cloudflare-api.ts`.
- MCP preflight does not validate `mime_type`; MIME compatibility is checked later by `uploadAndIndex(...)`. Do not interpret a successful preflight as proof that MIME matches the extension.

### Core save API fails

- Confirm D1 `DB`, R2 buckets, and `PROCESSING_QUEUE` bindings in `wrangler.jsonc`.
- Inspect the failing route in `registerUploaderApi(...)`.
- Check D1 tables from `db/migrations/0001_initial.sql`.
- Check Worker logs for R2, SQL batch, or queue errors.
- `wrangler.jsonc` and this source tree define only a queue producer. If messages are never processed, identify the separately deployed consumer; there is no consumer handler to debug here.

### Migration script fails

- Start with dry run: `npm run migrate:r2:dry`.
- Confirm `.env` values using placeholder names from `.env.example`.
- Check the selected inventory, manifest, source root, and mode flags.
- Reduce `--concurrency` and inspect `outputs/migration/runs/*`.

### Taxonomy cleanup is interrupted or times out

- Do not assume failure and do not manually delete source objects.
- Rerun `npm run cleanup:taxonomy` first. A completed move shows `source_exists: false` and `target_exists: true`.
- `npm run cleanup:taxonomy:apply` is idempotent: completed object moves return `already_moved`, and only remaining duplicate AI Search built-ins are deleted.
- Cleanup is complete when all reviewed mappings show absent sources/present targets and `duplicate_builtin_items` is `0`.

### Core deploy uploads but route update returns authentication error 10000

- Run `npx wrangler deployments status --config wrangler.jsonc` to determine whether the uploaded version became the active deployment.
- The custom-domain route update requires API-token permission for the `oskarcode.com` zone. Workers script permissions alone can upload and activate a version but cannot create or modify the route.
- Check `https://familyai.oskarcode.com/health`. A DNS resolution failure means the custom hostname still needs a valid DNS/custom-domain configuration; it is not evidence that the Worker bundle failed to upload.
- Do not repeatedly redeploy solely to fix a missing zone permission. Correct the token or route/DNS configuration, then verify again.

## Common Failure Modes

### Auth/Access failures

- Portal OAuth session expired.
- Portal admin credential cannot sync the upstream manifest.
- Access service-token headers are absent or stale.
- Worker has partial Access secret configuration.
- Worker has both Access secrets absent, which intentionally leaves public `/mcp` requests unauthenticated.

### Deployment/config drift

- Local MCP schemas changed without `npm run deploy:ingest`.
- Portal was not synced after deployment.
- ChatGPT retained an old connector session.
- Wrangler binding names differ from code expectations.
- A secret was configured on the wrong Worker/environment.

### Indexing/data sync lag

- AI Search item remains queued/running.
- Direct item upload failed and R2 sync fallback is slower.
- File required conversion/splitting.
- Search threshold is too strict for the query.
- Query metadata filters do not match indexed metadata.
- A caller reused core API vocabulary for MCP or vice versa: MCP sensitivities include `private`, while core uses `shared`; category aliases and provenance fields also differ.

## Logs and Status Signals

- Unified Worker health: `https://family-ai-ingest-mcp.oskarmansanqu.workers.dev/health`.
- Unified Worker MCP route: `https://family-ai-ingest-mcp.oskarmansanqu.workers.dev/mcp`; it is publicly routable because `workers_dev` is enabled, with authorization determined by optional Worker secrets.
- Core Worker health: `/health` on `familyai.oskarcode.com`.
- Upload fields to trust: `raw_key`, `index_keys`, `ai_search_item_uploads`, `warnings`, `notes`.
- Search fields to trust: `result.chunks[].text`, `.score`, `.item.key`, `.scoring_details`.
- Status field to watch: `item_statuses[].status`.
- Worker logs: `npx wrangler tail family-ai-ingest-mcp`.

## Quick Verification Commands

```bash
npm test
npx tsc --noEmit
npm run cleanup:taxonomy
npx wrangler deploy --config wrangler.jsonc --dry-run
npx wrangler deploy --config wrangler.ingest.jsonc --dry-run
npm run report:indexing-status -- --instance family-ai-chat-v3
npm run report:search-validation -- --instance family-ai-chat-v3
npm run report:ops-status -- --instance family-ai-chat-v3
```

## Ask-This-Question Prompts

- "Which function builds the response for the `search` MCP tool?"
- "Which file owns the auth check for `/mcp`?"
- "Which endpoint or tool confirms indexing status?"
- "Where are `validation_id` and `logical_folder` declared?"
- "Which function decides direct upload versus conversion and splitting?"
- "Which file builds the final R2 key?"
- "Which binding or secret does this failing operation require?"
- "Which function owns generated-text defaults and provenance?"
- "Does this ingestion path write D1, or only R2 and AI Search?"
- "Where is the core API authenticated?"
- "Which separately deployed component consumes `PROCESSING_QUEUE`?"
- "Which AI Search instance does this report command target?"
