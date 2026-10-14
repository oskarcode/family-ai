# File Guide

Family AI is now MCP-first. The old standalone core HTTP uploader, D1 database, queue producer, and `src/worker/` tree were removed.

## Active application files

| File or directory | Role |
|---|---|
| `src/ingest-worker/index.ts` | Worker entrypoint for `/health` and `/mcp` |
| `src/ingest-worker/server.ts` | MCP tool schemas and callbacks |
| `src/ingest-worker/search.ts` | Search via the `AI_SEARCH` Worker binding |
| `src/ingest-worker/ingestion.ts` | Validation, R2 original preservation, and AI Search built-in-storage uploads |
| `src/ingest-worker/deletion.ts` | Confirmed R2 raw object and AI Search item deletion |
| `src/ingest-worker/cloudflare-api.ts` | AI Search binding helpers |
| `src/ingest-worker/auth.ts` | Cloudflare Access service-token check for `/mcp` |
| `src/ingest-worker/file-utils.ts` | Filename, MIME, Base64, hashing, signing, and text helpers |
| `src/ingest-worker/config.ts` | MCP constants, limits, accepted values, and MIME hints |
| `src/lib/categories.ts` | Canonical category vocabulary and aliases |
| `src/lib/classifier.ts` | Filename/doc-type/sensitivity heuristics |
| `src/config/policy.ts` | Migration/report policy helper |
| `src/scripts/` | Operational migration, reporting, and cleanup commands |
| `wrangler.ingest.jsonc` | Only active Worker deployment config |
| `worker-configuration.ingest.d.ts` | Generated Worker runtime and binding types |

## Removed legacy files

- `src/worker/`
- `wrangler.jsonc`
- `worker-configuration.d.ts`
- `db/`
- `deploy:core` npm script

## Common maintenance

- Run tests: `npm test`
- Type-check: `npx tsc --noEmit`
- Dry-run deploy: `npx wrangler deploy --dry-run --config wrangler.ingest.jsonc`
- Deploy: `npm run deploy:ingest`
- Regenerate types after config changes: `npx wrangler types --config=wrangler.ingest.jsonc --env-interface=IngestEnv worker-configuration.ingest.d.ts`
