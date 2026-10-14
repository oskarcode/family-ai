# Troubleshooting

This repository now runs one active service: the Family AI MCP Worker configured by `wrangler.ingest.jsonc`. The former core HTTP uploader API, D1 schema, and queue producer were removed.

## `/mcp` returns `401 Unauthorized`

- Check `src/ingest-worker/auth.ts`.
- If `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` are configured on the deployed Worker, callers must send matching `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.
- If only one Access secret is configured, `/mcp` returns a misconfiguration error.

## `/health` works but MCP client cannot connect

- Verify the client is calling `/mcp`, not `/health`.
- Verify Access service-token headers are passed through the MCP client/portal.
- Run a local authenticated MCP smoke test with `@modelcontextprotocol/sdk` if needed.

## Search returns unexpected results

- Search now uses the `AI_SEARCH` Worker binding in `src/ingest-worker/search.ts`.
- Confirm the AI Search instance in `wrangler.ingest.jsonc` is `family-ai-chat-v3`.
- Check AI Search metadata filters: configured fields are `category`, `year`, `person`, `doc_type`, and `sensitivity`.

## Upload succeeds but the item is not immediately searchable

- New uploads preserve the original in `R2_RAW` and queue/index the item in AI Search built-in storage.
- Use `ingest_status` with the returned AI Search item ID.
- A returned status of `queued` or `running` means AI Search has accepted the item but indexing is not complete yet.

## Delete does not remove search results

- `delete_file` deletes matching `R2_RAW` objects and then looks up matching AI Search items by key.
- Use the exact `raw_key` returned by upload for new built-in-storage items.
- `confirm_delete: true` is required.
- Prefix deletion is intentionally guarded and refuses broad matches.

## Deployment checks

```sh
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run --config wrangler.ingest.jsonc
npm run deploy:ingest
```

## Current active resources

- Worker: `family-ai-ingest-mcp`
- R2 raw bucket: `family-raw`
- AI Search instance: `family-ai-chat-v3`
