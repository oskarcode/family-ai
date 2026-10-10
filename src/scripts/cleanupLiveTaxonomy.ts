// Node utilities load the untracked local environment without invoking a shell.
import fs from "node:fs";

// Dotenv parses credentials used by the Cloudflare REST APIs.
import dotenv from "dotenv";

// These exact mappings are the reviewed, bounded live-taxonomy migration scope.
const KEY_MOVES = [
  {
    source: "family/2026/shared/safety_smoke/chatgpt-safety-smoke-2026-07-13__2b7ba160.txt",
    target: "general/2026/shared/safety_smoke/chatgpt-safety-smoke-2026-07-13__2b7ba160.txt",
  },
  {
    source: "family/2026/shared/safety_smoke/chatgpt-safety-smoke-2026-07-13__ddaedcf6.txt",
    target: "general/2026/shared/safety_smoke/chatgpt-safety-smoke-2026-07-13__ddaedcf6.txt",
  },
  {
    source: "family/2026/shared/family_letter_summary/family_letter_quanjiaxin_summary_2026-07-20__cdd0d432.md",
    target: "relationship/2026/shared/family_letter_summary/family_letter_quanjiaxin_summary_2026-07-20__cdd0d432.md",
  },
  {
    source: "family/2026/shared/family_letter_full_context_en/family_letter_quanjiaxin_full_context_en_2026-07-20__f86b3701.txt",
    target: "relationship/2026/shared/family_letter_full_context_en/family_letter_quanjiaxin_full_context_en_2026-07-20__f86b3701.txt",
  },
  {
    source: "health/2026/kaitlin/health-summary/My-Health-Summary---Complete-Extracted-Record__0f2beeff.md",
    target: "medical/2026/kaitlin/health-summary/My-Health-Summary---Complete-Extracted-Record__0f2beeff.md",
  },
  {
    source: "finance/2026/shared/account_snapshot/etrade_current_account_value_2026-08-07__b58970c8.md",
    target: "financial/2026/shared/account_snapshot/etrade_current_account_value_2026-08-07__b58970c8.md",
  },
  {
    source: "financial/unknown/shared/tax/Passport.pdf",
    target: "immigration/unknown/shared/identity/Passport.pdf",
  },
] as const;

// Cleanup only touches the two buckets that can contain canonical document keys.
const R2_BUCKETS = ["family-raw", "family-index-ready-v3"] as const;
const AI_SEARCH_INSTANCE = "family-ai-chat-v3";
const AI_SEARCH_NAMESPACE = "default";

// R2ObjectMetadata is the bounded object-list shape needed for safe copy verification.
type R2ObjectMetadata = {
  key: string;
  size: number;
  etag: string;
  storage_class?: "Standard" | "InfrequentAccess";
  http_metadata?: { contentType?: string };
  custom_metadata?: Record<string, string>;
};

// AiSearchItem captures the fields used to prove that a built-in item duplicates an R2 item.
type AiSearchItem = {
  id: string;
  key: string;
  status: string;
  source_id: string;
};

// CloudflareEnvelope models the standard JSON wrapper returned by Cloudflare REST APIs.
type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { cursor?: string; is_truncated?: boolean; total_count?: number };
};

/**
 * Input:
 * - The current process arguments.
 * Output:
 * - True only when the explicit `--apply` flag is present.
 * What this function does:
 * - Keeps the default command read-only and makes mutations intentional.
 */
function shouldApply(): boolean {
  return process.argv.includes("--apply");
}

/**
 * Input:
 * - The local `.env` file and process environment.
 * Output:
 * - The account ID and bearer token required by the cleanup APIs.
 * What this function does:
 * - Loads secrets without printing them and fails before any API call when configuration is missing.
 */
function loadCredentials(): { accountId: string; apiToken: string } {
  const fileValues = fs.existsSync(".env") ? dotenv.parse(fs.readFileSync(".env", "utf8")) : {};
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || fileValues.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || fileValues.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required in the environment or .env file.");
  }
  return { accountId, apiToken };
}

/**
 * Input:
 * - An R2 object key that may contain slash-separated path segments.
 * Output:
 * - A URL-safe key whose slash separators remain literal.
 * What this function does:
 * - Encodes reserved filename characters without violating the R2 REST API slash requirement.
 */
function encodeObjectKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Input:
 * - A Cloudflare REST URL, bearer token, and optional fetch settings.
 * Output:
 * - The successful JSON envelope returned by Cloudflare.
 * What this function does:
 * - Applies authentication and turns HTTP or API failures into actionable errors.
 */
async function cloudflareJson<T>(url: string, apiToken: string, init: RequestInit = {}): Promise<CloudflareEnvelope<T>> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiToken}`);
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json() as CloudflareEnvelope<T>;
  if (!response.ok || !payload.success) {
    throw new Error(`${init.method || "GET"} ${url} failed (${response.status}): ${JSON.stringify(payload.errors || [])}`);
  }
  return payload;
}

/**
 * Input:
 * - Account credentials, bucket name, and optional key prefix.
 * Output:
 * - Every matching R2 object across all cursor pages.
 * What this function does:
 * - Produces the authoritative storage snapshot used for dry-run and verification.
 */
async function listR2Objects(accountId: string, apiToken: string, bucket: string, prefix = ""): Promise<R2ObjectMetadata[]> {
  const objects: R2ObjectMetadata[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ per_page: "1000" });
    if (prefix) query.set("prefix", prefix);
    if (cursor) query.set("cursor", cursor);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects?${query}`;
    const page = await cloudflareJson<R2ObjectMetadata[]>(url, apiToken);
    objects.push(...page.result);
    cursor = page.result_info?.is_truncated ? page.result_info.cursor : undefined;
  } while (cursor);
  return objects;
}

/**
 * Input:
 * - Account credentials, a bucket, and an existing object key.
 * Output:
 * - The object's bytes.
 * What this function does:
 * - Downloads a source object only when apply mode needs to create its canonical replacement.
 */
async function downloadR2Object(accountId: string, apiToken: string, bucket: string, key: string): Promise<ArrayBuffer> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeObjectKey(key)}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` } });
  if (!response.ok) throw new Error(`GET ${bucket}/${key} failed (${response.status}): ${await response.text()}`);
  return response.arrayBuffer();
}

/**
 * Input:
 * - Account credentials, destination key, source bytes, and source metadata.
 * Output:
 * - No value after Cloudflare confirms the upload.
 * What this function does:
 * - Recreates an object at its canonical key while preserving content and metadata.
 */
async function uploadR2Object(
  accountId: string,
  apiToken: string,
  bucket: string,
  key: string,
  bytes: ArrayBuffer,
  metadata: R2ObjectMetadata
): Promise<void> {
  const headers = new Headers({ "content-type": metadata.http_metadata?.contentType || "application/octet-stream" });
  if (metadata.storage_class) headers.set("cf-r2-storage-class", metadata.storage_class);
  for (const [name, value] of Object.entries(metadata.custom_metadata || {})) {
    const normalizedValue = name === "category" ? key.split("/", 1)[0] : value;
    headers.set(`x-amz-meta-${name}`, normalizedValue);
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeObjectKey(key)}`;
  await cloudflareJson(url, apiToken, { method: "PUT", headers, body: bytes });
}

/**
 * Input:
 * - Account credentials, bucket, and obsolete source key.
 * Output:
 * - No value after Cloudflare confirms deletion.
 * What this function does:
 * - Removes the old key only after the destination has passed size and ETag verification.
 */
async function deleteR2Object(accountId: string, apiToken: string, bucket: string, key: string): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeObjectKey(key)}`;
  await cloudflareJson(url, apiToken, { method: "DELETE" });
}

/**
 * Input:
 * - Account credentials for the configured AI Search instance.
 * Output:
 * - Every item across all page-number pages.
 * What this function does:
 * - Builds the index snapshot used to identify exact R2/built-in duplicates.
 */
async function listAiSearchItems(accountId: string, apiToken: string): Promise<AiSearchItem[]> {
  const items: AiSearchItem[] = [];
  let page = 1;
  let totalCount = Number.POSITIVE_INFINITY;
  while (items.length < totalCount) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/namespaces/${AI_SEARCH_NAMESPACE}/instances/${AI_SEARCH_INSTANCE}/items?page=${page}&per_page=50`;
    const response = await cloudflareJson<AiSearchItem[]>(url, apiToken);
    items.push(...response.result);
    totalCount = response.result_info?.total_count ?? items.length;
    page += 1;
  }
  return items;
}

/**
 * Input:
 * - The current AI Search item snapshot.
 * Output:
 * - Built-in items whose key also has a completed R2-backed item.
 * What this function does:
 * - Selects only provable duplicates and leaves unique built-in uploads untouched.
 */
function findDuplicateBuiltinItems(items: AiSearchItem[]): AiSearchItem[] {
  const completedR2Keys = new Set(
    items.filter((item) => item.source_id === "r2:family-index-ready-v3" && item.status === "completed").map((item) => item.key)
  );
  return items.filter((item) => item.source_id === "builtin" && completedR2Keys.has(item.key));
}

/**
 * Input:
 * - Account credentials and one verified duplicate AI Search item.
 * Output:
 * - No value after Cloudflare confirms deletion.
 * What this function does:
 * - Removes the redundant built-in copy while preserving the R2-backed item.
 */
async function deleteAiSearchItem(accountId: string, apiToken: string, item: AiSearchItem): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/namespaces/${AI_SEARCH_NAMESPACE}/instances/${AI_SEARCH_INSTANCE}/items/${item.id}`;
  await cloudflareJson(url, apiToken, { method: "DELETE" });
}

/**
 * Input:
 * - Account credentials after all R2 changes are complete.
 * Output:
 * - The asynchronous sync-job response.
 * What this function does:
 * - Requests immediate reconciliation of new, changed, and deleted R2 keys.
 */
async function triggerAiSearchSync(accountId: string, apiToken: string): Promise<unknown> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/instances/${AI_SEARCH_INSTANCE}/jobs`;
  const response = await cloudflareJson<unknown>(url, apiToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "Canonical taxonomy cleanup" }),
  });
  return response.result;
}

/**
 * Input:
 * - Account credentials, one bucket snapshot, and one approved key mapping.
 * Output:
 * - A status describing whether the source was absent, already moved, or moved now.
 * What this function does:
 * - Copies and verifies a canonical replacement before deleting its obsolete source key.
 */
async function applyObjectMove(
  accountId: string,
  apiToken: string,
  bucket: string,
  objects: R2ObjectMetadata[],
  move: (typeof KEY_MOVES)[number]
): Promise<string> {
  const source = objects.find((object) => object.key === move.source);
  const existingTarget = objects.find((object) => object.key === move.target);
  if (!source) return existingTarget ? "already_moved" : "source_absent";
  if (existingTarget && (existingTarget.size !== source.size || existingTarget.etag !== source.etag)) {
    throw new Error(`Refusing to overwrite conflicting target ${bucket}/${move.target}`);
  }

  if (!existingTarget) {
    const bytes = await downloadR2Object(accountId, apiToken, bucket, move.source);
    if (bytes.byteLength !== source.size) throw new Error(`Downloaded size mismatch for ${bucket}/${move.source}`);
    await uploadR2Object(accountId, apiToken, bucket, move.target, bytes, source);
  }

  // Re-list the exact destination before removing the source to make the copy operation fail-safe.
  const verified = (await listR2Objects(accountId, apiToken, bucket, move.target)).find((object) => object.key === move.target);
  if (!verified || verified.size !== source.size || verified.etag !== source.etag) {
    throw new Error(`Destination verification failed for ${bucket}/${move.target}`);
  }
  await deleteR2Object(accountId, apiToken, bucket, move.source);
  return existingTarget ? "removed_duplicate_source" : "moved";
}

/**
 * Input:
 * - Local environment configuration and optional `--apply` flag.
 * Output:
 * - A JSON audit report printed to stdout.
 * What this function does:
 * - Plans or executes the bounded taxonomy migration and duplicate-index cleanup.
 */
async function main(): Promise<void> {
  const apply = shouldApply();
  const { accountId, apiToken } = loadCredentials();
  const bucketSnapshots = new Map<string, R2ObjectMetadata[]>();
  for (const bucket of R2_BUCKETS) bucketSnapshots.set(bucket, await listR2Objects(accountId, apiToken, bucket));
  const aiItems = await listAiSearchItems(accountId, apiToken);
  const duplicateBuiltinItems = findDuplicateBuiltinItems(aiItems);

  const objectPlan = R2_BUCKETS.flatMap((bucket) => {
    const objects = bucketSnapshots.get(bucket) || [];
    return KEY_MOVES.map((move) => ({
      bucket,
      source: move.source,
      target: move.target,
      source_exists: objects.some((object) => object.key === move.source),
      target_exists: objects.some((object) => object.key === move.target),
    })).filter((entry) => entry.source_exists || entry.target_exists);
  });

  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", object_moves: objectPlan, duplicate_builtin_items: duplicateBuiltinItems.length }, null, 2));
    return;
  }

  const objectResults: Array<{ bucket: string; source: string; target: string; status: string }> = [];
  for (const bucket of R2_BUCKETS) {
    const objects = bucketSnapshots.get(bucket) || [];
    for (const move of KEY_MOVES) {
      const status = await applyObjectMove(accountId, apiToken, bucket, objects, move);
      if (status !== "source_absent") objectResults.push({ bucket, ...move, status });
    }
  }

  for (const item of duplicateBuiltinItems) await deleteAiSearchItem(accountId, apiToken, item);
  const syncJob = await triggerAiSearchSync(accountId, apiToken);
  console.log(JSON.stringify({
    mode: "apply",
    object_results: objectResults,
    deleted_duplicate_builtin_items: duplicateBuiltinItems.length,
    sync_job: syncJob,
  }, null, 2));
}

await main();
