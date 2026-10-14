# Family AI Learning Guide

Family AI is now a single MCP-first Cloudflare Worker. The old core HTTP uploader, D1 metadata database, and queue producer were removed to keep the project small.

## Mental model

| Concept | Where |
|---|---|
| Worker entrypoint | `src/ingest-worker/index.ts` |
| Tool routing | `src/ingest-worker/server.ts` |
| Search | `src/ingest-worker/search.ts` |
| Upload/indexing | `src/ingest-worker/ingestion.ts` |
| Deletion | `src/ingest-worker/deletion.ts` |
| Cloudflare integration | `src/ingest-worker/cloudflare-api.ts` |
| Shared categories/classification | `src/lib/` |
| Deployment config | `wrangler.ingest.jsonc` |

## Runtime flow

1. MCP client calls `/mcp`.
2. `index.ts` performs optional Access service-token auth.
3. `server.ts` dispatches the MCP tool.
4. Upload tools preserve originals in `family-raw` and upload searchable content to AI Search built-in storage.
5. Search uses the AI Search Worker binding.
6. Delete removes R2 originals and matching AI Search items.

## Things to remember

- New successful uploads no longer need a separate D1 row or queue message.
- AI Search metadata fields are limited, so the active schema uses: `category`, `year`, `person`, `doc_type`, `sensitivity`.
- Regenerate `worker-configuration.ingest.d.ts` after changing `wrangler.ingest.jsonc`.

## Checks

```sh
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run --config wrangler.ingest.jsonc
```
