// Node utilities provide filesystem access, path resolution, and deterministic hashing.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Application classifiers, policy, and types define migration enrichment decisions.
import { buildR2Key, detectCategory, detectDocType, detectPerson, detectSensitivity, detectYear } from "../lib/classifier.js";
import { decideProcessingStatus } from "../config/policy.js";
import type { EnrichedRecord, InventoryRecord, ProcessingStatus } from "../lib/types.js";

// The inventory payload is the source contract for migration planning.
type InventoryPayload = {
  root: string;
  total_files: number;
  records: InventoryRecord[];
};

// Project-relative paths keep generated planning artifacts in the standard workspace locations.
const WORKDIR = process.cwd();
const INVENTORY_PATH = path.join(WORKDIR, "data", "inventory", "family_inventory.json");
const OUTPUT_DIR = path.join(WORKDIR, "outputs", "migration");
const FOUR_MB = 4 * 1024 * 1024;

// Policy keywords assign operational priority without changing processing eligibility.
const HIGH_IMPORTANCE_KEYWORDS = [
  "tax",
  "w2",
  "1098",
  "1099",
  "mortgage",
  "loan",
  "bank",
  "statement",
  "medical",
  "health",
  "insurance",
  "pregnancy",
  "visa",
  "passport",
  "green card",
  "immigration",
  "ssn",
  "contract",
  "agreement",
  "legal",
  "inspection",
  "appraisal",
  "customs",
];

const MEDIUM_IMPORTANCE_KEYWORDS = ["house", "home", "rent", "relocation", "expenses", "portfolio", "benefits", "offer"];

/**
 * Input:
 * - A directory path.
 * Output:
 * - No return value; the directory exists after completion.
 * What this function does:
 * - Creates an output directory and any missing parents.
 */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Input:
 * - The path to a JSON inventory file.
 * Output:
 * - The parsed inventory payload.
 * What this function does:
 * - Reads and deserializes the source file inventory.
 */
function readInventory(filePath: string): InventoryPayload {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as InventoryPayload;
}

/**
 * Input:
 * - A string or number destined for a CSV field.
 * Output:
 * - A CSV-safe string representation.
 * What this function does:
 * - Escapes quotes and wraps fields containing CSV delimiters.
 */
function csvEscape(value: string | number): string {
  const asString = String(value);
  if (asString.includes(",") || asString.includes("\n") || asString.includes('"')) {
    return `"${asString.replace(/"/g, '""')}"`;
  }
  return asString;
}

/**
 * Input:
 * - An array of consistently shaped records.
 * Output:
 * - CSV text with a header row, or an empty string for no records.
 * What this function does:
 * - Serializes object rows into a CSV document.
 */
function toCsv<T extends object>(rows: T[]): string {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const lines = [headers.join(",")];

  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const line = headers.map((header) => csvEscape(record[header] as string | number)).join(",");
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Input:
 * - An enriched migration record.
 * Output:
 * - The record's high, medium, or low processing importance.
 * What this function does:
 * - Prioritizes backlog records using path keywords and processing status.
 */
function computeImportance(record: EnrichedRecord): "high" | "medium" | "low" {
  const lower = record.relative_path.toLowerCase();

  // Explicit personal-media exclusions win before broad keywords such as family names or locations.
  if (lower.includes("/zadia/photos") || lower.includes("/zadia/songs")) {
    return "low";
  }

  if (HIGH_IMPORTANCE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return "high";
  }

  if (MEDIUM_IMPORTANCE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return "medium";
  }

  // Processing status is the final fallback after path-based business priorities are considered.
  if (record.status === "store_only") {
    return "low";
  }

  return "medium";
}

/**
 * Input:
 * - Enriched migration records.
 * Output:
 * - Counts for every processing status.
 * What this function does:
 * - Aggregates the manifest into a complete status distribution.
 */
function statusCounts(records: EnrichedRecord[]): Record<ProcessingStatus, number> {
  const counts: Record<ProcessingStatus, number> = {
    index_now: 0,
    store_only: 0,
    split_then_index: 0,
    ocr_then_index: 0,
    extract_then_classify: 0,
    manual_review: 0,
    invalid_source: 0,
  };

  for (const record of records) {
    counts[record.status] += 1;
  }

  return counts;
}

/**
 * Input:
 * - A base R2 key and stable source-derived seed.
 * Output:
 * - The key with a deterministic hash suffix before its extension.
 * What this function does:
 * - Produces stable, collision-resistant keys without changing directory placement.
 */
function addDeterministicSuffixToKey(baseKey: string, seed: string): string {
  const hash = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
  const slash = baseKey.lastIndexOf("/");
  const dir = slash >= 0 ? baseKey.slice(0, slash + 1) : "";
  const file = slash >= 0 ? baseKey.slice(slash + 1) : baseKey;
  const dot = file.lastIndexOf(".");

  if (dot <= 0) {
    return `${dir}${file}--${hash}`;
  }

  return `${dir}${file.slice(0, dot)}--${hash}${file.slice(dot)}`;
}

/**
 * Input:
 * - Process arguments and inventory files from the configured working directory.
 * Output:
 * - Migration manifests, backlog files, and summary reports on disk.
 * What this function does:
 * - Classifies inventory records and generates the migration planning artifacts.
 */
function main(): void {
  ensureDir(OUTPUT_DIR);

  const payload = readInventory(INVENTORY_PATH);
  const staged = payload.records
    .slice()
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
    .map<EnrichedRecord>(
      /**
       * Input:
       * - One inventory record in deterministic path order.
       * Output:
       * - The record enriched with classification, policy, and target-key fields.
       * What this function does:
       * - Converts raw inventory metadata into a migration-ready record.
      */
      (record) => {
        const category = detectCategory(record.relative_path);
        const year = detectYear(record.relative_path);
        const person = detectPerson(record.relative_path);
        const docType = detectDocType(record.relative_path, record.extension.toLowerCase());
        const sensitivity = detectSensitivity(category);
        const decision = decideProcessingStatus(record);

        return {
          ...record,
          category,
          year,
          person,
          doc_type: docType,
          sensitivity,
          status: decision.status,
          status_reason: decision.reason,
          target_r2_key: buildR2Key(record, category, year, person, docType),
        };
      },
    );

  const keyCounts = new Map<string, number>();
  for (const record of staged) {
    keyCounts.set(record.target_r2_key, (keyCounts.get(record.target_r2_key) ?? 0) + 1);
  }

  const enriched = staged.map(
    /**
     * Input:
     * - One staged record and the precomputed target-key counts.
     * Output:
     * - The original record or a copy with a collision-safe target key.
     * What this function does:
     * - Resolves duplicate target keys deterministically across the manifest.
     */
    (record) => {
      const count = keyCounts.get(record.target_r2_key) ?? 0;
      if (count <= 1) {
        return record;
      }

      // Seed the suffix from immutable source attributes so repeated plans resolve collisions identically.
      return {
        ...record,
        target_r2_key: addDeterministicSuffixToKey(record.target_r2_key, `${record.relative_path}|${record.size_bytes}`),
        status_reason: `${record.status_reason} Collision-safe key suffix added.`,
      };
    },
  );

  const indexReady = enriched.filter((record) => record.status === "index_now");
  const uniqueIndexKeys = new Set(indexReady.map((record) => record.target_r2_key));

  const summary = {
    generated_at: new Date().toISOString(),
    source_inventory_path: INVENTORY_PATH,
    source_root: payload.root,
    total_records: enriched.length,
    status_counts: statusCounts(enriched),
    over_4mb_count: enriched.filter((record) => record.size_bytes > FOUR_MB).length,
    index_ready_count: enriched.filter((record) => record.status === "index_now").length,
    index_ready_unique_keys: uniqueIndexKeys.size,
    index_key_collisions_after_fix: indexReady.length - uniqueIndexKeys.size,
  };

  const over4MbBacklog = enriched
    .filter((record) => record.size_bytes > FOUR_MB)
    .map(
      /**
       * Input:
       * - One oversized enriched record.
       * Output:
       * - A concise backlog row with priority and suggested action.
       * What this function does:
       * - Translates processing policy into an operator-facing backlog entry.
       */
      (record) => ({
        importance: computeImportance(record),
        relative_path: record.relative_path,
        filename: record.filename,
        extension: record.extension,
        size_mb: Number((record.size_bytes / 1024 / 1024).toFixed(1)),
        category: record.category,
        person: record.person,
        status: record.status,
        status_reason: record.status_reason,
        suggested_action:
          record.status === "split_then_index"
            ? "Split document into <=4MB chunks in Phase 2"
            : record.status === "ocr_then_index"
              ? "OCR and convert to index-ready text/PDF in Phase 2"
              : record.status === "store_only"
                ? "Keep in R2 storage-only; excluded from indexing"
                : record.status === "extract_then_classify"
                  ? "Extract archive and classify contents in Phase 2"
                  : "Manual review",
      }),
    )
    .sort(
      /**
       * Input:
       * - Two oversized backlog rows.
       * Output:
       * - Their priority-first, path-second sort order.
       * What this function does:
       * - Keeps urgent work first while preserving deterministic ordering.
       */
      (a, b) => {
        const order = { high: 0, medium: 1, low: 2 } as const;
        return order[a.importance] - order[b.importance] || a.relative_path.localeCompare(b.relative_path);
      },
    );

  const summaryMarkdown = `# Family AI Migration Plan Summary

- Generated at: ${summary.generated_at}
- Source inventory: \`${summary.source_inventory_path}\`
- Total files analyzed: **${summary.total_records}**
- Files over 4MB: **${summary.over_4mb_count}**
- Index-ready now: **${summary.index_ready_count}**
- Unique index keys: **${summary.index_ready_unique_keys}**
- Index key collisions after fix: **${summary.index_key_collisions_after_fix}**

## Status counts

- index_now: ${summary.status_counts.index_now}
- store_only: ${summary.status_counts.store_only}
- split_then_index: ${summary.status_counts.split_then_index}
- ocr_then_index: ${summary.status_counts.ocr_then_index}
- extract_then_classify: ${summary.status_counts.extract_then_classify}
- manual_review: ${summary.status_counts.manual_review}
- invalid_source: ${summary.status_counts.invalid_source}

## Outputs

- \`outputs/migration/migration_manifest.json\`
- \`outputs/migration/migration_manifest.csv\`
- \`outputs/migration/processing_backlog_over_4mb.csv\`
- \`outputs/migration/summary.json\`
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "migration_manifest.json"), JSON.stringify(enriched, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, "migration_manifest.csv"), toCsv(enriched));
  fs.writeFileSync(path.join(OUTPUT_DIR, "processing_backlog_over_4mb.csv"), toCsv(over4MbBacklog));
  fs.writeFileSync(path.join(OUTPUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, "summary.md"), summaryMarkdown);

  console.log("Migration planning artifacts generated:");
  console.log(`- ${path.join(OUTPUT_DIR, "migration_manifest.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "migration_manifest.csv")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "processing_backlog_over_4mb.csv")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "summary.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "summary.md")}`);
}

main();
