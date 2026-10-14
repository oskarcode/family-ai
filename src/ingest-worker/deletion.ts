import { deleteAiSearchItem, listAiSearchItemsByKey } from "./cloudflare-api.js";
import type { EnvBindings, ToolResult } from "./types.js";

const MAX_DELETE_MATCHES = 100;

type DeleteInput = {
  key_or_prefix: string;
  match?: "exact" | "prefix";
  delete_ai_search_items?: boolean;
  confirm_delete?: boolean;
};

function isSafeObjectKey(value: string): boolean {
  return Boolean(
    value
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").includes("..")
    && !/[?*\[\]{}]/.test(value)
  );
}

async function listPrefixKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: Math.min(1000, MAX_DELETE_MATCHES - keys.length) });
    for (const object of page.objects) {
      keys.push(object.key);
      if (keys.length >= MAX_DELETE_MATCHES) break;
    }
    cursor = page.truncated && keys.length < MAX_DELETE_MATCHES ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Input:
 * - A confirmed canonical R2 raw key or narrow prefix.
 * Output:
 * - Deleted R2 raw objects, deleted AI Search items, and any item cleanup errors.
 * What this function does:
 * - Deletes only from the active simplified storage path: R2_RAW plus AI Search built-in storage.
 * - Refuses unsafe paths, missing confirmation, and overly broad prefix deletion.
 */
export async function deleteFamilyDocument(env: EnvBindings, input: DeleteInput): Promise<ToolResult> {
  const keyOrPrefix = input.key_or_prefix?.trim();
  const match = input.match ?? "exact";
  const deleteAiSearchItems = input.delete_ai_search_items ?? true;

  if (input.confirm_delete !== true) return { ok: false, error: "confirm_delete must be true." };
  if (!isSafeObjectKey(keyOrPrefix)) return { ok: false, error: "key_or_prefix must be a safe canonical object key or prefix." };
  if (match === "prefix" && keyOrPrefix.length < 12) {
    return { ok: false, error: "prefix deletes require at least 12 characters in key_or_prefix." };
  }

  const keys = match === "prefix"
    ? await listPrefixKeys(env.R2_RAW, keyOrPrefix)
    : [keyOrPrefix];
  if (match === "prefix" && keys.length >= MAX_DELETE_MATCHES) {
    return {
      ok: false,
      error: `Refusing to delete more than ${MAX_DELETE_MATCHES} objects. Use a narrower prefix.`,
      matched_count: keys.length,
    };
  }

  const deletedObjects: Array<{ bucket: string; key: string }> = [];
  const missingObjects: Array<{ bucket: string; key: string }> = [];
  for (const key of keys) {
    if (match === "exact") {
      const object = await env.R2_RAW.head(key);
      if (!object) {
        missingObjects.push({ bucket: "raw", key });
        continue;
      }
    }
    await env.R2_RAW.delete(key);
    deletedObjects.push({ bucket: "raw", key });
  }

  const deletedAiSearchItems: Array<{ id: string; key?: string }> = [];
  const aiSearchErrors: string[] = [];
  if (deleteAiSearchItems) {
    for (const key of keys) {
      try {
        const items = await listAiSearchItemsByKey(env, key);
        for (const item of items) {
          await deleteAiSearchItem(env, item.id);
          deletedAiSearchItems.push({ id: item.id, key: item.key ?? key });
        }
      } catch (error) {
        aiSearchErrors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    ok: true,
    deleted_objects: deletedObjects,
    deleted_object_count: deletedObjects.length,
    missing_objects: missingObjects,
    deleted_ai_search_items: deletedAiSearchItems,
    deleted_ai_search_item_count: deletedAiSearchItems.length,
    ai_search_errors: aiSearchErrors,
  };
}
