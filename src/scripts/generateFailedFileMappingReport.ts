// Node filesystem and path utilities load migration evidence and write remediation reports.
import fs from "node:fs";
import path from "node:path";

// Report input types capture only the manifest and indexing fields used by this script.
type ManifestRecord = {
  relative_path: string;
  extension: string;
  status: string;
  target_r2_key: string;
};

type IndexingStatusReport = {
  stats?: {
    file_embed_errors?: Record<string, number>;
    completed?: number;
    error?: number;
    queued?: number;
    running?: number;
  };
  expected_from_upload_step?: number;
  expected_unique_index_keys?: number;
  key_collision_count?: number;
};

// Project-relative paths keep source reports and generated mappings in one output directory.
const WORKDIR = process.cwd();
const OUTPUT_DIR = path.join(WORKDIR, "outputs", "migration");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "migration_manifest.json");
const INDEXING_STATUS_PATH = path.join(OUTPUT_DIR, "indexing_status_report.json");
const OUTPUT_JSON = path.join(OUTPUT_DIR, "failed_file_mapping_report.json");
const OUTPUT_MD = path.join(OUTPUT_DIR, "failed_file_mapping_report.md");
const OUTPUT_CSV = path.join(OUTPUT_DIR, "failed_file_mapping_report.csv");

// This policy set identifies formats that require conversion or storage-only handling.
const UNSUPPORTED_EXTENSIONS = new Set(["heic", "pages", "doc", "rtf"]);

/**
 * Input:
 * - A JSON file path and the value to use when the file is absent.
 * Output:
 * - The parsed JSON value or the supplied fallback.
 * What this function does:
 * - Loads optional migration report data without failing on missing files.
 */
function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

/**
 * Input:
 * - Report rows represented as records with a shared column shape.
 * Output:
 * - CSV text with escaped values and a header row.
 * What this function does:
 * - Serializes failed-file mapping rows for spreadsheet use.
 */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  /**
   * Input:
   * - One failed-file report field value.
   * Output:
   * - A CSV-safe string representation of the value.
   * What this function does:
   * - Quotes delimiter-bearing fields and escapes embedded quotes.
   */
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes("\n") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * Input:
 * - The migration manifest and current indexing-status report from disk.
 * Output:
 * - JSON, Markdown, and CSV reports mapping indexing failures to remediation actions.
 * What this function does:
 * - Correlates key collisions, unsupported formats, and AI Search conversion errors.
 */
function main(): void {
  const manifest = readJson<ManifestRecord[]>(MANIFEST_PATH, []);
  const indexing = readJson<IndexingStatusReport>(INDEXING_STATUS_PATH, {});

  // Group index candidates by destination key so overwritten source files can be identified.
  const indexNow = manifest.filter((r) => r.status === "index_now");
  const keyToSources = new Map<string, string[]>();
  for (const rec of indexNow) {
    const existing = keyToSources.get(rec.target_r2_key) ?? [];
    existing.push(rec.relative_path);
    keyToSources.set(rec.target_r2_key, existing);
  }

  const collisionRows: Array<Record<string, unknown>> = [];
  for (const [key, paths] of keyToSources) {
    if (paths.length > 1) {
      collisionRows.push({
        reason: "key_collision_overwrite",
        target_r2_key: key,
        source_count: paths.length,
        source_paths: paths.join(" | "),
        next_plan: "Append a stable hash or doc_id suffix to target filename to avoid overwrite collisions.",
      });
    }
  }

  // Map policy-approved but unsupported source formats to their format-specific remediation.
  const unsupportedRows = indexNow
    .filter((r) => UNSUPPORTED_EXTENSIONS.has(r.extension.toLowerCase()))
    .map(
      /**
       * Input:
       * - An index candidate with an unsupported extension.
       * Output:
       * - A failed-file mapping row with a format-aware next plan.
       * What this function does:
       * - Converts an unsupported candidate into an actionable remediation record.
       */
      (r) => ({
        reason: "unsupported_type",
        target_r2_key: r.target_r2_key,
        source_count: 1,
        source_paths: r.relative_path,
        next_plan:
          r.extension.toLowerCase() === "heic"
            ? "Convert HEIC to PDF/PNG (document images) or keep as store_only media."
            : "Convert to PDF/DOCX/TXT in Phase 2 or mark as store_only.",
      }),
    );

  const summaryRows: Array<Record<string, unknown>> = [];
  const fileErrors = indexing.stats?.file_embed_errors ?? {};
  // Translate aggregate AI Search error classes into operator-facing recovery guidance.
  for (const [errType, count] of Object.entries(fileErrors)) {
    summaryRows.push({
      reason: errType,
      target_r2_key: "(see AI Search item logs)",
      source_count: count,
      source_paths: "",
      next_plan:
        errType === "unable_to_convert_to_markdown"
          ? "Retry conversion with pre-processing or convert manually to text-friendly format."
          : errType === "markdown_conversion_empty" || errType === "file_content_empty"
            ? "Inspect document content; re-export file to standard PDF/DOCX and re-upload."
            : "Review and transform unsupported files in Phase 2.",
    });
  }

  const combined = [...summaryRows, ...collisionRows, ...unsupportedRows];

  const payload = {
    generated_at: new Date().toISOString(),
    totals: {
      uploaded_index_candidates: indexing.expected_from_upload_step ?? indexNow.length,
      unique_index_keys: indexing.expected_unique_index_keys ?? keyToSources.size,
      key_collisions: indexing.key_collision_count ?? collisionRows.length,
      completed: indexing.stats?.completed ?? 0,
      error: indexing.stats?.error ?? 0,
      queued: indexing.stats?.queued ?? 0,
      running: indexing.stats?.running ?? 0,
    },
    file_embed_errors: fileErrors,
    collision_examples: collisionRows.slice(0, 30),
    unsupported_type_candidates: unsupportedRows.slice(0, 120),
    rows: combined,
  };

  const nextPlanLines: string[] = [];
  // Collision remediation leads the plan because later uploads cannot recover overwritten objects.
  if ((payload.totals.key_collisions ?? 0) > 0) {
    nextPlanLines.push(
      "1. **Fix key collisions first**: add deterministic hash/doc_id suffix into canonical filename and re-run index-only upload for collided records.",
    );
  } else {
    nextPlanLines.push("1. **Collision fix complete**: no current key-collision overwrite detected.");
  }
  nextPlanLines.push(
    "2. **Move unsupported types out of index path**: HEIC/pages/doc/rtf should be transformed or marked store-only before indexing.",
  );
  nextPlanLines.push("3. **Retry conversion errors**: re-export problematic files and re-upload to active index bucket.");
  nextPlanLines.push("4. Re-run: `npm run report:indexing-status` and `npm run report:search-validation -- --wait`.");

  const markdown = `# Failed File Mapping Report\n\n- Generated at: ${payload.generated_at}\n\n## Summary\n\n- Uploaded index candidates: **${payload.totals.uploaded_index_candidates}**\n- Unique index keys: **${payload.totals.unique_index_keys}**\n- Collision overwrites: **${payload.totals.key_collisions}**\n- Index completed: **${payload.totals.completed}**\n- Index errors: **${payload.totals.error}**\n- Queue/running: **${payload.totals.queued}/${payload.totals.running}**\n\n## Why Some Files Did Not Become Searchable\n\n1. **Key collisions (overwrite at upload time)**: ${payload.totals.key_collisions}\n   - Multiple source files mapped to the same \`target_r2_key\`; only the last upload survives.\n2. **AI Search conversion/type errors**: ${(payload.totals.error ?? 0)}\n   - ${Object.entries(fileErrors)
     .map(([k, v]) => `${k}: ${v}`)
     .join("; ") || "none"}\n\n## Collision Examples (Top 30)\n\n${collisionRows
  .slice(0, 30)
  .map((r) => `- \`${r.target_r2_key}\` <= ${r.source_count} sources`)
  .join("\n") || "- none"}\n\n## Unsupported Type Candidates (Top 40)\n\n${unsupportedRows
  .slice(0, 40)
  .map((r) => `- \`${r.source_paths}\` -> \`${r.target_r2_key}\``)
  .join("\n") || "- none"}\n\n## Next Plan\n\n${nextPlanLines.join("\n")}\n`;

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(payload, null, 2));
  fs.writeFileSync(OUTPUT_MD, markdown);
  fs.writeFileSync(OUTPUT_CSV, toCsv(combined));

  console.log("Failed file mapping report generated:");
  console.log(`- ${OUTPUT_JSON}`);
  console.log(`- ${OUTPUT_MD}`);
  console.log(`- ${OUTPUT_CSV}`);
}

main();
