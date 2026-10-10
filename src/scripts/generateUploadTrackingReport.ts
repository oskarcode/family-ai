// Node filesystem and path utilities read migration evidence and write report artifacts.
import fs from "node:fs";
import path from "node:path";

// Shared migration types keep report inputs aligned with the generated manifest.
import type { EnrichedRecord } from "../lib/types.js";

// Input report shapes describe the persisted evidence consumed by this script.
type InventoryPayload = { root: string };
type UploadError = { path: string; error: string };
type RunReport = {
  mode: "raw_only" | "index_only" | "raw_and_index";
  raw_bucket?: string;
  index_bucket?: string;
  successful_raw_paths: string[];
  successful_index_paths: string[];
  errors: Array<{ path: string; error: string }>;
};

// All input and output paths are resolved from the project working directory.
const WORKDIR = process.cwd();
const MANIFEST_PATH = path.join(WORKDIR, "outputs", "migration", "migration_manifest.json");
const INVENTORY_PATH = path.join(WORKDIR, "data", "inventory", "family_inventory.json");
const ERRORS_PATH = path.join(WORKDIR, "outputs", "migration", "migration_upload_errors.json");
const MANUAL_RESOLVED_PATH = path.join(WORKDIR, "outputs", "migration", "manual_resolved_uploads.json");
const RUNS_DIR = path.join(WORKDIR, "outputs", "migration", "runs");
const RAW_RUN_PATH = path.join(RUNS_DIR, "latest_raw_only.json");
const INDEX_RUN_PATH = path.join(RUNS_DIR, "latest_index_only.json");
const OUTPUT_JSON = path.join(WORKDIR, "outputs", "migration", "upload_tracking_report.json");
const OUTPUT_CSV = path.join(WORKDIR, "outputs", "migration", "upload_tracking_report.csv");
const OUTPUT_MD = path.join(WORKDIR, "outputs", "migration", "upload_tracking_report.md");

/**
 * Input:
 * - A JSON file path and the value to use when the file is absent.
 * Output:
 * - The parsed JSON value or the supplied fallback.
 * What this function does:
 * - Loads optional report inputs without failing on missing files.
 */
function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

/**
 * Input:
 * - Report rows represented as records with a shared column shape.
 * Output:
 * - CSV text with a header row and escaped field values.
 * What this function does:
 * - Serializes report records into spreadsheet-compatible CSV.
 */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  /**
   * Input:
   * - One report field value.
   * Output:
   * - A CSV-safe string representation of the value.
   * What this function does:
   * - Quotes fields containing CSV delimiters and doubles embedded quotes.
   */
  const escaped = (v: unknown) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes("\n") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escaped(row[h])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Input:
 * - An enriched migration record and any unresolved upload error for it.
 * Output:
 * - The next operational action recommended for the record.
 * What this function does:
 * - Prioritizes failure recovery before selecting the policy-specific follow-up plan.
 */
function nextPlanByStatus(record: EnrichedRecord, unresolvedError?: string): string {
  // Upload failures take precedence over normal policy progression when selecting the next action.
  if (unresolvedError?.includes("300 MiB")) {
    return "Optional media archival: use R2 S3 API multipart upload (or skip because media is store-only for MVP).";
  }
  if (unresolvedError) {
    return "Retry failed upload in its corresponding step.";
  }
  if (record.status === "index_now") {
    return "Upload/copy to family-index-ready-v3 and trigger AI Search sync.";
  }
  if (record.status === "split_then_index") {
    return "Phase 2: split file into <=4MB chunks before indexing.";
  }
  if (record.status === "extract_then_classify") {
    return "Phase 2: extract archive and classify child files.";
  }
  if (record.status === "store_only") {
    return "Keep storage-only in R2; excluded from indexing by policy.";
  }
  if (record.status === "ocr_then_index") {
    return "Phase 2: OCR document-like image then index extracted text.";
  }
  if (record.status === "invalid_source") {
    return "No migration action; artifact or invalid source.";
  }
  return "Manual review required.";
}

/**
 * Input:
 * - Raw upload error text from the CLI or Cloudflare API.
 * Output:
 * - A normalized reason code for reporting.
 * What this function does:
 * - Groups known failure messages into stable operational categories.
 */
function reasonCode(errorText: string): string {
  if (errorText.includes("300 MiB")) return "wrangler_upload_limit_300MiB";
  if (errorText.includes("internal error") || errorText.includes("Internal Server Error")) return "cloudflare_internal_error";
  if (errorText.includes("Local file missing")) return "local_file_missing";
  return "cloudflare_api_or_cli_error";
}

/**
 * Input:
 * - Migration manifests, inventory metadata, upload runs, and manual resolution records from disk.
 * Output:
 * - JSON, CSV, and Markdown upload-tracking reports.
 * What this function does:
 * - Reconciles transfer evidence and policy state into one operational report.
 */
function main(): void {
  const manifest = readJson<EnrichedRecord[]>(MANIFEST_PATH, []);
  const inventory = readJson<InventoryPayload>(INVENTORY_PATH, { root: "" });
  const errors = readJson<UploadError[]>(ERRORS_PATH, []);
  const manualResolved = new Set(readJson<string[]>(MANUAL_RESOLVED_PATH, []));
  const rawRun = readJson<RunReport | null>(RAW_RUN_PATH, null);
  const indexRun = readJson<RunReport | null>(INDEX_RUN_PATH, null);
  const rawBucket = rawRun?.raw_bucket ?? "family-raw";
  const indexBucket = indexRun?.index_bucket ?? "family-index-ready-v3";

  const rawSuccess = new Set<string>(rawRun?.successful_raw_paths ?? []);
  const indexSuccess = new Set<string>(indexRun?.successful_index_paths ?? []);

  // Reconcile historical errors with manual resolutions, then let latest step errors restore active failures.
  const unresolvedErrorMap = new Map<string, string>();
  for (const e of errors) {
    if (!manualResolved.has(e.path)) {
      unresolvedErrorMap.set(e.path, e.error);
    }
  }

  for (const e of rawRun?.errors ?? []) {
    unresolvedErrorMap.set(e.path, e.error);
  }
  for (const e of indexRun?.errors ?? []) {
    unresolvedErrorMap.set(e.path, e.error);
  }

  const rows = manifest.map(
    /**
     * Input:
     * - One enriched manifest record.
     * Output:
     * - A transfer-status row with destinations, failure reason, and next plan.
     * What this function does:
     * - Reconciles policy, successful run evidence, and unresolved errors for one source file.
     */
    (record) => {
      const sourceAbsolutePath = path.join(inventory.root, record.relative_path);
      const unresolvedError = unresolvedErrorMap.get(sourceAbsolutePath);
      const isInvalid = record.status === "invalid_source";

      // Transfer evidence follows a strict preference: inapplicable, confirmed success, active failure, then unknown.
      const rawTransferStatus = isInvalid
        ? "not_applicable"
        : rawSuccess.has(record.relative_path)
          ? "transferred"
          : unresolvedError
            ? "not_transferred"
            : "unknown_or_not_attempted";

      const indexTarget = record.status === "index_now" ? `${indexBucket}/${record.target_r2_key}` : "n/a";
      const indexTransferStatus =
        record.status !== "index_now"
          ? "not_planned_phase1"
          : indexSuccess.has(record.relative_path)
            ? "transferred"
            : unresolvedError
              ? "not_transferred"
              : "unknown_or_not_attempted";

      return {
        relative_path: record.relative_path,
        size_mb: Number((record.size_bytes / 1024 / 1024).toFixed(1)),
        category: record.category,
        person: record.person,
        policy_status: record.status,
        raw_destination: isInvalid ? "n/a" : `${rawBucket}/${record.relative_path}`,
        raw_transfer_status: rawTransferStatus,
        raw_not_transferred_reason: unresolvedError ? reasonCode(unresolvedError) : "",
        index_destination: indexTarget,
        index_transfer_status: indexTransferStatus,
        next_plan: nextPlanByStatus(record, unresolvedError),
      };
    },
  );

  const total = rows.length;
  const rawTransferred = rows.filter((r) => r.raw_transfer_status === "transferred").length;
  const rawNotTransferred = rows.filter((r) => r.raw_transfer_status === "not_transferred").length;
  const rawUnknown = rows.filter((r) => r.raw_transfer_status === "unknown_or_not_attempted").length;
  const invalid = rows.filter((r) => r.raw_transfer_status === "not_applicable").length;
  const indexNow = rows.filter((r) => r.policy_status === "index_now").length;
  const indexTransferred = rows.filter((r) => r.index_transfer_status === "transferred").length;
  const indexNotTransferred = rows.filter((r) => r.index_transfer_status === "not_transferred").length;
  const indexUnknown = rows.filter((r) => r.index_transfer_status === "unknown_or_not_attempted").length;

  const unresolvedTop = rows
    .filter((r) => r.raw_transfer_status === "not_transferred" || r.index_transfer_status === "not_transferred")
    .slice(0, 20)
    .map((r) => `- \`${r.relative_path}\` | reason: ${r.raw_not_transferred_reason}`)
    .join("\n");

  const markdown = `# Data Upload Tracking Report\n\n- Generated at: ${new Date().toISOString()}\n- Source manifest: \`outputs/migration/migration_manifest.json\`\n- Step reports used:\n  - Raw step: \`${fs.existsSync(RAW_RUN_PATH) ? RAW_RUN_PATH : "not found"}\`\n  - Index step: \`${fs.existsSync(INDEX_RUN_PATH) ? INDEX_RUN_PATH : "not found"}\`\n\n## Summary\n\n- Total manifest records: **${total}**\n- Invalid source (not applicable): **${invalid}**\n\n### Step 1 - Raw archival to ${rawBucket}\n- Transferred: **${rawTransferred}**\n- Not transferred: **${rawNotTransferred}**\n- Unknown/not attempted: **${rawUnknown}**\n\n### Step 2 - Index-ready copy to ${indexBucket} (index_now only)\n- Index-eligible total: **${indexNow}**\n- Transferred: **${indexTransferred}**\n- Not transferred: **${indexNotTransferred}**\n- Unknown/not attempted: **${indexUnknown}**\n\n## What Changed\n\n- Step 1 destination: \`${rawBucket}/<original_relative_path>\`\n- Step 2 destination: \`${indexBucket}/<target_r2_key>\` for \`index_now\` documents\n\n## What Did Not Change\n\n${unresolvedTop || "- None"}\n\n## Next Plan\n\n1. Resolve step failures listed above (or skip oversized videos by policy).\n2. Trigger AI Search indexing from active index bucket (currently \`${indexBucket}\`).\n3. Produce indexing status report (indexed, failed, pending).\n4. Phase 2 backlog: split >4MB docs, OCR document-like images, extract archives.\n`;

  const outputPayload = {
    generated_at: new Date().toISOString(),
    summary: {
      total_records: total,
      raw_transferred: rawTransferred,
      raw_not_transferred: rawNotTransferred,
      raw_unknown_or_not_attempted: rawUnknown,
      invalid_source: invalid,
      index_now_total: indexNow,
      index_transferred: indexTransferred,
      index_not_transferred: indexNotTransferred,
      index_unknown_or_not_attempted: indexUnknown,
    },
    unresolved_errors: rows.filter((r) => r.raw_transfer_status === "not_transferred" || r.index_transfer_status === "not_transferred"),
    records: rows,
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(outputPayload, null, 2));
  fs.writeFileSync(OUTPUT_CSV, toCsv(rows));
  fs.writeFileSync(OUTPUT_MD, markdown);

  console.log("Upload tracking report generated:");
  console.log(`- ${OUTPUT_JSON}`);
  console.log(`- ${OUTPUT_CSV}`);
  console.log(`- ${OUTPUT_MD}`);
}

main();
