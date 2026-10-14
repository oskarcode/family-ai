# Codebase Overview

Family AI is now a single MCP-first Cloudflare Worker. The old standalone core HTTP uploader API, D1 metadata schema, and queue producer were removed so the active path is easier to maintain.

## Active runtime

```text
MCP client / ChatGPT
  -> src/ingest-worker/index.ts
  -> src/ingest-worker/server.ts
  -> search / ingestion / deletion helpers
  -> R2_RAW for preserved originals
  -> Cloudflare AI Search built-in storage + index
```

## Important files

| Path | Purpose |
|---|---|
| `src/ingest-worker/index.ts` | Worker `/health` and `/mcp` entrypoint |
| `src/ingest-worker/server.ts` | MCP tool registration and schemas |
| `src/ingest-worker/search.ts` | AI Search binding search; older R2 prefix retrieval fallback |
| `src/ingest-worker/ingestion.ts` | Upload validation, original preservation, AI Search item upload |
| `src/ingest-worker/deletion.ts` | Confirmed R2 and AI Search item deletion |
| `src/ingest-worker/cloudflare-api.ts` | AI Search binding helpers plus REST fallback helpers |
| `src/lib/` | Shared categories, classifier, and types |
| `src/config/policy.ts` | Migration/reporting policy helpers |
| `src/scripts/` | Operational migration/report/cleanup scripts |
| `wrangler.ingest.jsonc` | The only active Worker deploy config |
| `worker-configuration.ingest.d.ts` | Generated Worker and binding types |

## Removed legacy path

These were intentionally removed:

- `src/worker/`: previous Hono HTTP uploader/document API.
- `wrangler.jsonc`: previous `family-ai-core` Worker config.
- `worker-configuration.d.ts`: generated types for the removed core Worker.
- `db/`: previous D1 schema/migrations.
- Queue producer binding and `PROCESSING_QUEUE` usage.
- `R2_PROCESSED` binding.

## Active Cloudflare resources

- Worker: `family-ai-ingest-mcp`.
- R2 raw bucket: `family-raw`.
- Legacy index-ready bucket: `family-index-ready-v3`, still bound for old prefix retrieval and compatibility.
- AI Search instance: `family-ai-chat-v3`.
- AI Search custom metadata fields: `category`, `year`, `person`, `doc_type`, `sensitivity`.

## Development checks

```sh
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run --config wrangler.ingest.jsonc
```

## Deployment

```sh
npm run deploy:ingest
```
