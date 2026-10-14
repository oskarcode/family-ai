# Family AI

Family AI is a Cloudflare Worker MCP server for private family-document search and ingestion. It lets trusted MCP clients search indexed records, preserve submitted originals in private R2, and upload searchable content to Cloudflare AI Search built-in storage.

## What It Does

- Exposes one MCP endpoint with search, ingestion, status, capability, and guarded deletion tools.
- Preserves original submitted documents in the `family-raw` R2 bucket.
- Uploads newly ingested searchable content directly to Cloudflare AI Search built-in storage.
- Supports ChatGPT file-param uploads, Base64 validated uploads, generated Markdown ingestion, and exact/prefix deletion with confirmation.
- Keeps the old index-ready R2 bucket bound only for backward-compatible prefix retrieval of legacy artifacts.

## How It Works

```text
MCP client
  -> POST /mcp on the Worker
  -> optional Cloudflare Access service-token check
  -> MCP tool registry in src/ingest-worker/server.ts
  -> search / ingestion / deletion service modules
  -> R2 raw originals + Cloudflare AI Search
  -> MCP structuredContent response
```

The previous standalone core HTTP uploader API, D1 metadata database, and queue producer were removed. The active runtime is the MCP Worker configured by `wrangler.ingest.jsonc`.

## Technology Stack

| Technology | Role |
|---|---|
| Cloudflare Workers | Runs the MCP server and `/health` route |
| Agents SDK `createMcpHandler` | Adapts the MCP server to Streamable HTTP transport |
| MCP TypeScript SDK | Defines and tests MCP server/tool behavior |
| Zod | Runtime schemas for MCP tool inputs and outputs |
| Cloudflare R2 | Stores preserved original family files |
| Cloudflare AI Search | Stores/indexes/searches current searchable content |
| Vitest | Unit/integration tests for tool registration and flows |
| Wrangler | Type generation, dry-run packaging, and deployment |

## Project Structure

| Path | Purpose |
|---|---|
| `src/ingest-worker/index.ts` | Worker entrypoint for `/health` and `/mcp` |
| `src/ingest-worker/server.ts` | MCP tool schemas, annotations, and callbacks |
| `src/ingest-worker/search.ts` | AI Search binding search plus legacy prefix retrieval |
| `src/ingest-worker/ingestion.ts` | Upload validation, R2 preservation, AI Search upload |
| `src/ingest-worker/deletion.ts` | Confirmed R2 and AI Search deletion |
| `src/ingest-worker/cloudflare-api.ts` | AI Search binding helpers and REST fallbacks |
| `src/lib/` | Shared category/classifier/type helpers |
| `src/scripts/` | Operational migration, reporting, and cleanup commands |
| `wrangler.ingest.jsonc` | Active Worker deployment config |
| `worker-configuration.ingest.d.ts` | Generated Worker runtime/binding types |

## APIs and Interfaces

### HTTP routes

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `GET` | `/health` | Health/version/tool-list response | Public |
| `POST` | `/mcp` | MCP Streamable HTTP endpoint | Cloudflare Access service-token headers when configured |

### MCP tools

| Tool | Purpose |
|---|---|
| `family_ai_server_info` | Server identity and tool contract |
| `search` | Search indexed family documents |
| `ingest_chatgpt_file` | Ingest a ChatGPT file-param attachment |
| `ingest_validate_file` | Preflight a Base64 upload |
| `ingest_upload_validated_file` | Upload validated Base64 bytes |
| `ingest_generated_text` | Store derived Markdown when original bytes are unavailable |
| `ingest_status` | Check AI Search item status |
| `delete_file` | Confirmed R2/AI Search deletion |

## Run It Locally

Prerequisites:

- Node.js compatible with the project lockfile.
- Cloudflare account resources equivalent to the bindings in `wrangler.ingest.jsonc`.
- Worker secrets configured locally or remotely as needed.

Install and verify:

```sh
npm install
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run --config wrangler.ingest.jsonc
```

Generate Worker types after changing `wrangler.ingest.jsonc`:

```sh
npx wrangler types --config=wrangler.ingest.jsonc --env-interface=IngestEnv worker-configuration.ingest.d.ts
```

## Deploy Your Own Copy

1. Create or choose an AI Search instance and R2 buckets.
2. Update `wrangler.ingest.jsonc` with your Worker name, bucket names, AI Search instance name, account-safe public variables, and route settings.
3. Set required secrets with Wrangler, not in source code.
4. Run:

```sh
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run --config wrangler.ingest.jsonc
npm run deploy:ingest
```

## Security Notes

- `/mcp` checks `CF-Access-Client-Id` and `CF-Access-Client-Secret` when both `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` are configured as Worker secrets.
- If neither Access secret exists, the current code allows `/mcp` requests. For private deployments, configure both secrets and put the endpoint behind the intended Access/Portal boundary.
- `/health` is intentionally public and does not expose document contents.
- `delete_file` requires `confirm_delete: true`, rejects unsafe paths, and limits broad prefix deletion.
- Secret names used by the Worker include `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `PREFLIGHT_SIGNING_SECRET`, and optional `CF_API_TOKEN` for REST fallback paths.
- Do not commit `.env` values, Access service-token values, Cloudflare API tokens, or private document data.

## Customize It

| Goal | Start here | Verify |
|---|---|---|
| Add/change an MCP tool | `src/ingest-worker/server.ts` | `npm test`, MCP listTools smoke test |
| Change upload metadata vocabulary | `src/ingest-worker/config.ts`, `src/lib/categories.ts` | category/classifier tests |
| Change storage key behavior | `src/ingest-worker/ingestion.ts`, `src/ingest-worker/file-utils.ts` | ingestion tests and remote upload smoke test |
| Change search behavior | `src/ingest-worker/search.ts` | search tests and AI Search smoke query |
| Change deletion safety | `src/ingest-worker/deletion.ts` | deletion tests and non-production delete smoke test |
| Change Cloudflare bindings | `wrangler.ingest.jsonc` | regenerate types, type-check, dry-run deploy |

## Troubleshooting

| Symptom | Check |
|---|---|
| `/mcp` returns `401` | Access service-token headers and `src/ingest-worker/auth.ts` |
| Search returns no results | AI Search instance binding, metadata filters, and `src/ingest-worker/search.ts` |
| Upload preserves raw file but no search item appears | `ingest_status`, AI Search item logs, and `src/ingest-worker/cloudflare-api.ts` |
| Delete leaves search results | Exact key match, AI Search item list/delete behavior, and `src/ingest-worker/deletion.ts` |
| Type errors after config changes | Regenerate `worker-configuration.ingest.d.ts` |

## Official References

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Cloudflare AI Search: https://developers.cloudflare.com/ai-search/
- Cloudflare R2: https://developers.cloudflare.com/r2/
- Cloudflare Agents MCP docs: https://developers.cloudflare.com/agents/model-context-protocol/
- Model Context Protocol: https://modelcontextprotocol.io/
- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/

## License

No explicit root project license is currently included. Add a `LICENSE` file before publishing this repository publicly.
