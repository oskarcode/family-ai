// Search configuration and input types keep the proxy aligned with Family AI schemas.
import { AI_SEARCH_MCP_URL } from "./config.js";
import type { EnvBindings, SearchInput } from "./types.js";

const SOURCE_CHUNK_CHARS = 4_000;
const MAX_SOURCE_CHUNKS = 50;
const CATEGORY_FILTER_KEYS = new Set(["category", "metadata.category"]);

type SearchChunk = {
  item?: {
    key?: string;
    metadata?: Record<string, unknown>;
  };
  scoring_details?: Record<string, unknown>;
  [key: string]: unknown;
};

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + SOURCE_CHUNK_CHARS);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n\n", end);
      if (paragraph > start) end = paragraph;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
    while (text[start] === "\n") start += 1;
  }
  return chunks.filter(Boolean);
}

function isTextObject(key: string, contentType?: string): boolean {
  return Boolean(
    contentType?.startsWith("text/")
    || contentType === "application/json"
    || /\.(?:csv|html?|json|md|markdown|txt|xml|ya?ml)$/i.test(key)
  );
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getRequestedCategory(input: SearchInput): string | undefined {
  const options = getObject(input.ai_search_options);
  const retrieval = getObject(options?.retrieval);
  const filters = getObject(retrieval?.filters);
  if (!filters) return undefined;

  const key = typeof filters.key === "string" ? filters.key : undefined;
  const value = typeof filters.value === "string" ? filters.value : undefined;
  if (key && CATEGORY_FILTER_KEYS.has(key) && value) return value;

  for (const filterKey of CATEGORY_FILTER_KEYS) {
    const directValue = filters[filterKey];
    if (typeof directValue === "string") return directValue;
    const filterValue = getObject(directValue);
    if (typeof filterValue?.$eq === "string") return filterValue.$eq;
  }

  return undefined;
}

function chunkMatchesCategory(chunk: SearchChunk, category: string): boolean {
  const key = chunk.item?.key;
  const metadataCategory = chunk.item?.metadata?.category;
  return metadataCategory === category || Boolean(key?.startsWith(`${category}/`));
}

function applyCategoryResultFilter(
  result: Record<string, unknown>,
  category: string
): Record<string, unknown> {
  const searchResult = getObject(result.result);
  const chunks = searchResult?.chunks;
  if (!Array.isArray(chunks)) return result;

  const typedChunks = chunks as SearchChunk[];
  const matching = typedChunks.filter((chunk) => chunkMatchesCategory(chunk, category));
  if (!matching.length || matching.length === typedChunks.length) return result;

  return {
    ...result,
    result: {
      ...searchResult,
      chunks: matching.map((chunk) => ({
        ...chunk,
        scoring_details: {
          ...chunk.scoring_details,
          family_ai_category_filter: category,
        },
      })),
      family_ai_category_filter_meta: {
        category,
        original_chunk_count: typedChunks.length,
        returned_chunk_count: matching.length,
      },
    },
  };
}

async function retrieveSourcePrefixes(
  env: EnvBindings,
  input: SearchInput
): Promise<Record<string, unknown>> {
  const keys = new Set<string>();

  for (const prefix of input.source_prefixes || []) {
    let cursor: string | undefined;
    do {
      const page = await env.R2_INDEX_READY.list({ prefix, cursor, limit: MAX_SOURCE_CHUNKS });
      for (const object of page.objects) {
        keys.add(object.key);
        if (keys.size >= MAX_SOURCE_CHUNKS) break;
      }
      cursor = page.truncated && keys.size < MAX_SOURCE_CHUNKS ? page.cursor : undefined;
    } while (cursor);
    if (keys.size >= MAX_SOURCE_CHUNKS) break;
  }

  const chunks: Array<Record<string, unknown>> = [];
  for (const key of keys) {
    const object = await env.R2_INDEX_READY.get(key);
    if (!object || !isTextObject(key, object.httpMetadata?.contentType)) continue;
    const parts = splitText(await object.text());
    for (let index = 0; index < parts.length && chunks.length < MAX_SOURCE_CHUNKS; index += 1) {
      chunks.push({
        id: `${key}#${index + 1}`,
        type: "text",
        score: 1,
        text: parts[index],
        item: {
          key,
          timestamp: object.uploaded?.getTime(),
          metadata: {
            ...object.customMetadata,
            source_prefix_retrieval: true,
          },
        },
        scoring_details: { retrieval_type: "source_prefix" },
      });
    }
    if (chunks.length >= MAX_SOURCE_CHUNKS) break;
  }

  return {
    success: true,
    result: {
      query_kind: "source_prefix",
      search_query: input.query,
      chunks,
      source_prefix_meta: {
        requested_prefixes: input.source_prefixes,
        matched_object_count: keys.size,
        returned_chunk_count: chunks.length,
      },
    },
  };
}

/**
 * Input:
 * - A family-document search query and optional AI Search controls.
 * Output:
 * - The parsed search result or a structured failure response.
 * What this function does:
 * - Calls the AI Search MCP tool and extracts its structured text result.
 */
export async function searchFamilyDocuments(
  env: EnvBindings,
  input: SearchInput
): Promise<Record<string, unknown>> {
  if (input.source_prefixes?.length) return retrieveSourcePrefixes(env, input);

  const response = await fetch(AI_SEARCH_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: "search", arguments: input },
    }),
  });

  if (!response.ok) {
    return { success: false, error: `AI Search MCP request failed (${response.status})` };
  }

  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return { success: false, error: "AI Search MCP returned an invalid response." };

  try {
    const rpc = JSON.parse(dataLine.slice(6)) as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    };
    if (rpc.error) return { success: false, error: rpc.error.message || "AI Search MCP RPC error." };
    const text = rpc.result?.content?.find((item) => item.type === "text")?.text;
    if (!text) return { success: false, error: "AI Search MCP returned no structured search result." };
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result = typeof parsed.success === "boolean"
      ? parsed
      : { success: true, result: parsed };
    const category = getRequestedCategory(input);
    return category ? applyCategoryResultFilter(result, category) : result;
  } catch {
    return { success: false, error: "AI Search MCP response could not be parsed." };
  }
}
