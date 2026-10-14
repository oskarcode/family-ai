// Shared types define Worker bindings and extensible MCP operation results.
import type { EnvBindings, ToolResult } from "./types.js";

function getAiSearchInstance(env: EnvBindings): AiSearchInstance {
  if (!env.AI_SEARCH) throw new Error("AI_SEARCH binding is required for this Worker.");
  return env.AI_SEARCH;
}

/**
 * Input:
 * - Worker bindings, an AI Search item key, MIME type, bytes, and optional metadata.
 * Output:
 * - The created AI Search item identifier, key, and status.
 * What this function does:
 * - Uploads one preserved Family AI artifact directly to AI Search built-in storage.
 */
export async function uploadItemToAiSearch(
  env: EnvBindings,
  indexFilename: string,
  mimeType: string,
  payload: Uint8Array,
  metadata?: Record<string, unknown>
): Promise<{ id: string; key: string; status: string }> {
  const body = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  const item = await getAiSearchInstance(env).items.upload(indexFilename, new Blob([body], { type: mimeType }), { metadata });
  return { id: item.id, key: item.key, status: item.status };
}

/**
 * Input:
 * - Worker bindings and an exact or prefix-like Family AI key.
 * Output:
 * - Matching AI Search items known to the configured instance.
 * What this function does:
 * - Uses the AI Search binding only, so missing binding configuration fails clearly.
 */
export async function listAiSearchItemsByKey(
  env: EnvBindings,
  key: string
): Promise<Array<{ id: string; key?: string; status?: string }>> {
  const result = await getAiSearchInstance(env).items.list({ search: key, per_page: 50 });
  return result.result
    .filter((item) => item.key === key || item.key?.startsWith(key))
    .map((item) => ({ id: item.id, key: item.key, status: item.status }));
}

/**
 * Input:
 * - Worker bindings and an AI Search item id.
 * Output:
 * - Nothing when deletion succeeds.
 * What this function does:
 * - Deletes the item through the configured AI Search binding.
 */
export async function deleteAiSearchItem(env: EnvBindings, itemId: string): Promise<void> {
  await getAiSearchInstance(env).items.delete(itemId);
}

/**
 * Input:
 * - Worker bindings and AI Search item identifiers.
 * Output:
 * - Current item statuses or a structured validation/configuration error.
 * What this function does:
 * - Polls indexing state through the AI Search binding only.
 */
export async function checkStatus(env: EnvBindings, input: { item_ids: string[] }): Promise<ToolResult> {
  const itemIds = Array.isArray(input.item_ids) ? input.item_ids.map((item) => String(item)).filter(Boolean) : [];
  if (itemIds.length === 0) return { ok: false, error: "item_ids (array) is required" };

  try {
    const statuses: unknown[] = [];
    for (const itemId of itemIds) {
      statuses.push(await getAiSearchInstance(env).items.get(itemId).info());
    }
    return { ok: true, item_statuses: statuses };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
