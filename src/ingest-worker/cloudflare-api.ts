// Ingestion helpers identify direct text formats and construct multipart bodies.
import { DIRECT_TEXT_EXTENSIONS } from "./config.js";
import { buildMultipartSingleFile } from "./file-utils.js";

// Shared types define Worker bindings and extensible MCP operation results.
import type { EnvBindings, ToolResult } from "./types.js";

// The short-lived cache avoids repeated supported-format API requests.
let formatCache: { expiresAt: number; byExtension: Map<string, string> } | null = null;

function getAiSearchInstance(env: EnvBindings): AiSearchInstance | null {
  return env.AI_SEARCH || null;
}

/**
 * Input:
 * - Worker bindings, a Cloudflare API path, request options, and optional content type.
 * Output:
 * - The typed API result payload.
 * What this function does:
 * - Sends an authenticated Cloudflare API request and normalizes failures.
 */
export async function cloudflareApi<T = unknown>(
  env: EnvBindings,
  path: string,
  init: RequestInit,
  contentType?: string
): Promise<T> {
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN is not configured on the worker.");
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${env.CF_API_TOKEN}`);
  if (contentType) headers.set("content-type", contentType);
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers });
  const json = (await response.json()) as { success?: boolean; errors?: Array<{ message?: string }>; result?: T };
  if (!response.ok || json.success === false) {
    const message = json.errors?.[0]?.message || `Cloudflare API request failed (${response.status})`;
    throw new Error(message);
  }
  return (json.result || json) as T;
}

/**
 * Input:
 * - Worker bindings containing Cloudflare account credentials.
 * Output:
 * - A map of supported extensions to MIME types.
 * What this function does:
 * - Combines direct text formats with cached To Markdown capabilities.
 */
export async function fetchSupportedFormats(env: EnvBindings): Promise<Map<string, string>> {
  const now = Date.now();
  if (formatCache && formatCache.expiresAt > now) return formatCache.byExtension;

  const byExtension = new Map<string, string>();
  for (const extension of DIRECT_TEXT_EXTENSIONS) byExtension.set(extension, "text/plain");

  try {
    const result = await cloudflareApi<Array<{ extension: string; mimeType: string }>>(
      env,
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown/supported`,
      { method: "GET" }
    );
    for (const item of result) {
      byExtension.set(item.extension.replace(/^\./, "").toLowerCase(), item.mimeType);
    }
  } catch {
    // The direct text fallback remains available without the conversion API.
  }

  formatCache = { expiresAt: now + 15 * 60 * 1000, byExtension };
  return byExtension;
}

// ToMarkdownResult mirrors the conversion API entries used by ingestion.
type ToMarkdownResult = Array<{ data: string; name: string; mimeType: string }>;

/**
 * Input:
 * - Worker bindings, source file details, and source bytes.
 * Output:
 * - Non-empty Markdown returned by Cloudflare's conversion API.
 * What this function does:
 * - Converts supported binary family documents into indexable Markdown.
 */
export async function convertToMarkdownViaApi(
  env: EnvBindings,
  filename: string,
  mime: string,
  bytes: Uint8Array
): Promise<string> {
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN required for markdown conversion API.");
  const multipart = buildMultipartSingleFile("files", filename, mime, bytes);
  const result = await cloudflareApi<ToMarkdownResult>(
    env,
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown`,
    { method: "POST", body: multipart.body },
    multipart.contentType
  );
  const markdown = result?.[0]?.data || "";
  if (!markdown.trim()) throw new Error("Conversion API returned empty markdown output.");
  return markdown;
}

/**
 * Input:
 * - Worker bindings, index filename, MIME type, and index payload bytes.
 * Output:
 * - The created AI Search item identifier, key, and status.
 * What this function does:
 * - Uploads one index-ready Family AI artifact without waiting for completion.
 */
export async function uploadItemToAiSearch(
  env: EnvBindings,
  indexFilename: string,
  mimeType: string,
  payload: Uint8Array,
  metadata?: Record<string, unknown>
): Promise<{ id: string; key: string; status: string }> {
  const instance = getAiSearchInstance(env);
  if (instance) {
    const body = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
    const item = await instance.items.upload(indexFilename, new Blob([body], { type: mimeType }), { metadata });
    return { id: item.id, key: item.key, status: item.status };
  }

  const multipart = buildMultipartSingleFile("file", indexFilename, mimeType, payload, [
    { name: "wait_for_completion", value: "false" },
  ]);
  return cloudflareApi<{ id: string; key: string; status: string }>(
    env,
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-search/namespaces/${env.AI_SEARCH_NAMESPACE}/instances/${env.AI_SEARCH_INSTANCE_ID}/items`,
    { method: "POST", body: multipart.body },
    multipart.contentType
  );
}

type AiSearchItemsList = {
  items?: Array<{ id?: string; key?: string; status?: string }>;
  result?: Array<{ id?: string; key?: string; status?: string }>;
};

export async function listAiSearchItemsByKey(
  env: EnvBindings,
  key: string
): Promise<Array<{ id: string; key?: string; status?: string }>> {
  const instance = getAiSearchInstance(env);
  if (instance) {
    const result = await instance.items.list({ search: key, per_page: 50 });
    return result.result
      .filter((item) => item.key === key || item.key?.startsWith(key))
      .map((item) => ({ id: item.id, key: item.key, status: item.status }));
  }

  if (!env.CF_API_TOKEN) return [];
  const result = await cloudflareApi<AiSearchItemsList | Array<{ id?: string; key?: string; status?: string }>>(
    env,
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-search/namespaces/${env.AI_SEARCH_NAMESPACE}/instances/${env.AI_SEARCH_INSTANCE_ID}/items?key=${encodeURIComponent(key)}`,
    { method: "GET" }
  );
  const items = Array.isArray(result)
    ? result
    : Array.isArray(result.items)
      ? result.items
      : Array.isArray(result.result) ? result.result : [];
  return items.flatMap((item) => typeof item.id === "string" ? [{ id: item.id, key: item.key, status: item.status }] : []);
}

export async function deleteAiSearchItem(env: EnvBindings, itemId: string): Promise<void> {
  const instance = getAiSearchInstance(env);
  if (instance) {
    await instance.items.delete(itemId);
    return;
  }

  await cloudflareApi(
    env,
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-search/namespaces/${env.AI_SEARCH_NAMESPACE}/instances/${env.AI_SEARCH_INSTANCE_ID}/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE" }
  );
}

/**
 * Input:
 * - Worker bindings and a sync-job description.
 * Output:
 * - The created job summary, or null when unavailable.
 * What this function does:
 * - Requests an AI Search sync as a best-effort ingestion fallback.
 */
export async function triggerSyncJob(env: EnvBindings, description: string): Promise<{ id?: string } | null> {
  const instance = getAiSearchInstance(env);
  if (instance) {
    try {
      return await instance.jobs.create({ description });
    } catch {
      return null;
    }
  }

  if (!env.CF_API_TOKEN) return null;
  try {
    return await cloudflareApi<{ id: string }>(
      env,
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-search/instances/${env.AI_SEARCH_INSTANCE_ID}/jobs`,
      { method: "POST", body: JSON.stringify({ description }) },
      "application/json"
    );
  } catch {
    return null;
  }
}

/**
 * Input:
 * - Worker bindings and AI Search item identifiers.
 * Output:
 * - Current item statuses or a structured validation/configuration error.
 * What this function does:
 * - Polls indexing state for artifacts returned by Family AI ingestion.
 */
export async function checkStatus(env: EnvBindings, input: { item_ids: string[] }): Promise<ToolResult> {
  const itemIds = Array.isArray(input.item_ids) ? input.item_ids.map((item) => String(item)).filter(Boolean) : [];
  if (itemIds.length === 0) return { ok: false, error: "item_ids (array) is required" };

  const instance = getAiSearchInstance(env);
  if (instance) {
    const statuses: unknown[] = [];
    for (const itemId of itemIds) {
      statuses.push(await instance.items.get(itemId).info());
    }
    return { ok: true, item_statuses: statuses };
  }

  if (!env.CF_API_TOKEN) return { ok: false, error: "AI Search binding or CF_API_TOKEN is required for ingest_status" };

  const statuses: unknown[] = [];
  for (const itemId of itemIds) {
    const result = await cloudflareApi(
      env,
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-search/namespaces/${env.AI_SEARCH_NAMESPACE}/instances/${env.AI_SEARCH_INSTANCE_ID}/items/${itemId}`,
      { method: "GET" }
    );
    statuses.push(result);
  }
  return { ok: true, item_statuses: statuses };
}
