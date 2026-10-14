import { deleteAiSearchItem, listAiSearchItemsByKey } from "./cloudflare-api.js";
import type { EnvBindings, ToolResult } from "./types.js";

const MAX_DELETE_MATCHES = 100;

type DeleteInput = {
  key_or_prefix: string;
  match?: "exact" | "prefix";
  buckets?: "index_ready" | "raw" | "both";
  delete_ai_search_items?: boolean;
  confirm_delete?: boolean;
};

type BucketTarget = {
  name: "raw" | "index_ready";
  bucket: R2Bucket;
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

function targetsFor(env: EnvBindings, buckets: DeleteInput["buckets"]): BucketTarget[] {
  if (buckets === "raw") return [{ name: "raw", bucket: env.R2_RAW }];
  if (buckets === "index_ready") return [{ name: "index_ready", bucket: env.R2_INDEX_READY }];
  return [
    { name: "raw", bucket: env.R2_RAW },
    { name: "index_ready", bucket: env.R2_INDEX_READY },
  ];
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

export async function deleteFamilyDocument(env: EnvBindings, input: DeleteInput): Promise<ToolResult> {
  const keyOrPrefix = input.key_or_prefix?.trim();
  const match = input.match ?? "exact";
  const buckets = input.buckets ?? "both";
  const deleteAiSearchItems = input.delete_ai_search_items ?? true;

  if (input.confirm_delete !== true) return { ok: false, error: "confirm_delete must be true." };
  if (!isSafeObjectKey(keyOrPrefix)) return { ok: false, error: "key_or_prefix must be a safe canonical object key or prefix." };
  if (match === "prefix" && keyOrPrefix.length < 12) {
    return { ok: false, error: "prefix deletes require at least 12 characters in key_or_prefix." };
  }

  const targetBuckets = targetsFor(env, buckets);
  const deletedObjects: Array<{ bucket: string; key: string }> = [];
  const missingObjects: Array<{ bucket: string; key: string }> = [];
  const aiSearchKeys = new Set<string>();

  for (const target of targetBuckets) {
    const keys = match === "prefix"
      ? await listPrefixKeys(target.bucket, keyOrPrefix)
      : [keyOrPrefix];
    if (match === "prefix" && keys.length >= MAX_DELETE_MATCHES) {
      return {
        ok: false,
        error: `Refusing to delete more than ${MAX_DELETE_MATCHES} objects. Use a narrower prefix.`,
        matched_count: keys.length,
      };
    }

    for (const key of keys) {
      if (match === "exact") {
        const object = await target.bucket.head(key);
        if (!object) {
          missingObjects.push({ bucket: target.name, key });
          continue;
        }
      }
      await target.bucket.delete(key);
      deletedObjects.push({ bucket: target.name, key });
      aiSearchKeys.add(key);
    }
  }

  const deletedAiSearchItems: Array<{ id: string; key?: string }> = [];
  const aiSearchErrors: string[] = [];
  if (deleteAiSearchItems) {
    for (const key of aiSearchKeys) {
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
    notes: deleteAiSearchItems && !env.AI_SEARCH && !env.CF_API_TOKEN
      ? "R2 objects were deleted. Neither AI Search binding nor CF_API_TOKEN is configured, so AI Search items could not be removed directly."
      : undefined,
  };
}
