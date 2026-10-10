// Node utilities read local evidence, resolve output paths, and query Wrangler synchronously.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Input and API response types describe the evidence reconciled by this report.
type UploadTrackingSummary = {
  summary?: {
    index_transferred?: number;
  };
};

type ManifestRecord = {
  status: string;
  target_r2_key: string;
};

type AiSearchInstance = {
  id: string;
  type: string | null;
  source: string | null;
  status: string;
  namespace: string;
  chunk_size: number;
  max_num_results: number;
  index_method?: { vector?: boolean; keyword?: boolean };
  created_at: string;
  modified_at: string;
};

type AiSearchStats = {
  last_activity: string;
  file_embed_errors: Record<string, number>;
  queued: number;
  running: number;
  completed: number;
  error: number;
  skipped: number;
  outdated: number;
  engine?: {
    vectorize?: {
      vectorsCount?: number;
      dimensions?: number;
    };
  };
};

// Project-relative paths locate upload evidence, the manifest, and report outputs.
const WORKDIR = process.cwd();
const OUTPUT_DIR = path.join(WORKDIR, "outputs", "migration");
const UPLOAD_TRACKING_PATH = path.join(OUTPUT_DIR, "upload_tracking_report.json");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "migration_manifest.json");

/**
 * Input:
 * - Command-line argument tokens.
 * Output:
 * - The selected AI Search instance identifier.
 * What this function does:
 * - Parses the optional instance override with a stable default.
 */
function parseArgs(argv: string[]): { instanceId: string } {
  let instanceId = "family-ai-chat-v3";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--instance" && argv[i + 1]) {
      instanceId = argv[i + 1];
      i += 1;
    }
  }
  return { instanceId };
}

/**
 * Input:
 * - A JSON path and fallback value.
 * Output:
 * - Parsed file content, or the fallback when the file is absent.
 * What this function does:
 * - Loads optional migration report inputs safely.
 */
function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

/**
 * Input:
 * - Wrangler command arguments.
 * Output:
 * - Parsed JSON emitted by Wrangler.
 * What this function does:
 * - Executes a local Wrangler command with consistent JSON settings.
 */
function runWranglerJson(commandArgs: string[]): unknown {
  const out = execFileSync("npx", ["wrangler", ...commandArgs, "--json"], {
    cwd: WORKDIR,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * Input:
 * - CLI arguments, migration reports, manifest data, and live AI Search state.
 * Output:
 * - JSON and Markdown indexing status reports on disk.
 * What this function does:
 * - Reconciles uploaded candidates with unique keys and indexing progress.
 */
function main(): void {
  const { instanceId } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const instance = runWranglerJson(["ai-search", "get", instanceId]) as AiSearchInstance;
  const stats = runWranglerJson(["ai-search", "stats", instanceId]) as AiSearchStats;
  const uploadTracking = readJson<UploadTrackingSummary>(UPLOAD_TRACKING_PATH, {});
  const manifest = readJson<ManifestRecord[]>(MANIFEST_PATH, []);

  const uniqueIndexKeys = new Set(
    manifest.filter((r) => r.status === "index_now").map((r) => r.target_r2_key),
  );

  const expectedToIndex = uploadTracking.summary?.index_transferred ?? 0;
  const expectedUniqueToIndex = uniqueIndexKeys.size;
  // Reconcile terminal AI Search states against unique keys because colliding uploads overwrite objects.
  const processed = stats.completed + stats.error + stats.skipped + stats.outdated;
  const percent = expectedUniqueToIndex > 0 ? ((processed / expectedUniqueToIndex) * 100).toFixed(1) : "0.0";
  const remaining = Math.max(0, expectedUniqueToIndex - processed);
  const keyCollisionCount = Math.max(0, expectedToIndex - expectedUniqueToIndex);

  const payload = {
    generated_at: new Date().toISOString(),
    instance,
    stats,
    expected_from_upload_step: expectedToIndex,
    expected_unique_index_keys: expectedUniqueToIndex,
    key_collision_count: keyCollisionCount,
    processed_count: processed,
    remaining_count: remaining,
    completion_percent: Number(percent),
  };

  const markdown = `# AI Search Indexing Status Report\n\n- Generated at: ${payload.generated_at}\n- Instance: \`${instance.id}\`\n- Source bucket: \`${instance.source ?? "n/a"}\`\n- Instance status: **${instance.status}**\n\n## Progress\n\n- Uploaded index candidates (Step 2): **${expectedToIndex}**\n- Unique index keys (after canonical-key dedupe): **${expectedUniqueToIndex}**\n- Key collisions detected (same target key overwritten): **${keyCollisionCount}**\n- Completed: **${stats.completed}**\n- Error: **${stats.error}**\n- Skipped: **${stats.skipped}**\n- Outdated: **${stats.outdated}**\n- Queued: **${stats.queued}**\n- Running: **${stats.running}**\n- Processed (completed+error+skipped+outdated): **${processed}**\n- Remaining (unique expected - processed): **${remaining}**\n- Completion (vs unique expected): **${percent}%**\n\n## What Changed\n\n- Indexing has started and is actively processing documents from \`${instance.source ?? "n/a"}\`.\n- Vector index count currently: **${stats.engine?.vectorize?.vectorsCount ?? 0}** vectors.\n\n## What Has Not Changed Yet\n\n- If queued/running are non-zero, remaining documents are still not fully searchable.\n- Files with conversion/format issues are in error and require follow-up handling.\n\n## Current Error Breakdown\n\n${Object.entries(stats.file_embed_errors)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n") || "- none"}\n\n## Next Plan\n\n1. Re-run this report until queued=0 and running=0.\n2. Export failed file list from AI Search logs and map to source paths.\n3. Decide retries/transforms for failed formats (Phase 2 OCR/split/extract backlog).\n4. Run validation searches against \`${instance.id}\` and capture search quality report.\n`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "indexing_status_report.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, "indexing_status_report.md"), markdown);

  console.log("Indexing status report generated:");
  console.log(`- ${path.join(OUTPUT_DIR, "indexing_status_report.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "indexing_status_report.md")}`);
}

main();
