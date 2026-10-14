// Load local environment values before reading migration credentials and overrides.
import "dotenv/config";

// Node utilities provide file access, path handling, subprocess execution, and Promise adaptation.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The AWS SDK supplies R2's S3-compatible upload client.
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Shared manifest types define each migration record consumed by the migration tool.
import type { EnrichedRecord } from "../lib/types.js";

// Promise-based subprocess execution supports the asynchronous Wrangler fallback.
const execFileAsync = promisify(execFile);

// Script-owned types define CLI options, planned uploads, and persisted run evidence.
type InventoryPayload = {
  root: string;
};

type CliConfig = {
  apply: boolean;
  manifestPath: string;
  inventoryPath: string;
  sourceRootOverride?: string;
  concurrency: number;
  limit?: number;
  rawOnly: boolean;
  indexOnly: boolean;
};

type UploadPlanItem = {
  record: EnrichedRecord;
  sourceAbsolutePath: string;
  rawKey: string;
  uploadIndexReady: boolean;
};

// Project-relative paths locate default inputs and retain run reports for later reconciliation.
const WORKDIR = process.cwd();
const DEFAULT_MANIFEST_PATH = path.join(WORKDIR, "outputs", "migration", "migration_manifest.json");
const DEFAULT_INVENTORY_PATH = path.join(WORKDIR, "data", "inventory", "family_inventory.json");
const RUN_REPORT_DIR = path.join(WORKDIR, "outputs", "migration", "runs");

// Run modes and reports record exactly which destinations were selected and completed.
type RunMode = "raw_only" | "index_only" | "raw_and_index";

type RunReport = {
  run_id: string;
  mode: RunMode;
  generated_at: string;
  apply: boolean;
  manifest_path: string;
  source_root: string;
  selected_records: number;
  selected_bytes: number;
  selected_index_candidates: number;
  raw_bucket: string;
  index_bucket: string;
  raw_uploads: number;
  index_uploads: number;
  errors: Array<{ path: string; error: string }>;
  successful_raw_paths: string[];
  successful_index_paths: string[];
  skipped_paths: string[];
  elapsed_seconds: number;
};

/**
 * Input:
 * - Parsed CLI configuration.
 * Output:
 * - The effective raw/index upload mode.
 * What this function does:
 * - Converts mutually exclusive upload flags into a reportable run mode.
 */
function deriveRunMode(config: CliConfig): RunMode {
  if (config.rawOnly) return "raw_only";
  if (config.indexOnly) return "index_only";
  return "raw_and_index";
}

/**
 * Input:
 * - Command-line argument tokens.
 * Output:
 * - Validated migration CLI configuration.
 * What this function does:
 * - Applies defaults, parses supported flags, and rejects invalid combinations.
 */
function parseArgs(argv: string[]): CliConfig {
  const config: CliConfig = {
    apply: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    inventoryPath: DEFAULT_INVENTORY_PATH,
    concurrency: 4,
    rawOnly: false,
    indexOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      config.apply = true;
      continue;
    }
    if (arg === "--manifest" && argv[i + 1]) {
      config.manifestPath = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--inventory" && argv[i + 1]) {
      config.inventoryPath = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--source-root" && argv[i + 1]) {
      config.sourceRootOverride = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--concurrency" && argv[i + 1]) {
      config.concurrency = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      config.limit = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--raw-only") {
      config.rawOnly = true;
      continue;
    }
    if (arg === "--index-only") {
      config.indexOnly = true;
      continue;
    }
  }

  if (config.rawOnly && config.indexOnly) {
    throw new Error("Use only one of --raw-only or --index-only.");
  }

  if (!Number.isFinite(config.concurrency) || config.concurrency < 1) {
    throw new Error("--concurrency must be a positive number.");
  }

  if (config.limit !== undefined && (!Number.isFinite(config.limit) || config.limit < 1)) {
    throw new Error("--limit must be a positive number.");
  }

  return config;
}

/**
 * Input:
 * - A file path and human-readable label.
 * Output:
 * - No return value when the file exists; otherwise an error is thrown.
 * What this function does:
 * - Prevents migration work from starting with a missing required input.
 */
function assertFileExists(filePath: string, label: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

/**
 * Input:
 * - A JSON file path and expected result type.
 * Output:
 * - The parsed JSON value.
 * What this function does:
 * - Reads typed migration configuration or manifest data from disk.
 */
function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

/**
 * Input:
 * - A source-relative path.
 * Output:
 * - An R2-safe relative key without leading slashes.
 * What this function does:
 * - Prevents source paths from becoming root-style object keys.
 */
function sanitizeRawKey(relativePath: string): string {
  return relativePath.replace(/^\/+/, "");
}

/**
 * Input:
 * - A filename extension.
 * Output:
 * - Its known MIME type, or undefined when unmapped.
 * What this function does:
 * - Supplies content metadata for common family document formats.
 */
function inferContentType(extension: string): string | undefined {
  const ext = extension.toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    txt: "text/plain",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    numbers: "application/vnd.apple.numbers",
    pages: "application/vnd.apple.pages",
    html: "text/html",
    rtf: "application/rtf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    heic: "image/heic",
    zip: "application/zip",
    "7z": "application/x-7z-compressed",
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext];
}

/**
 * Input:
 * - The name of a required environment variable.
 * Output:
 * - Its non-empty value.
 * What this function does:
 * - Reads required configuration and throws when it is unavailable.
 */
function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Input:
 * - The name of an optional environment variable.
 * Output:
 * - Its value when defined.
 * What this function does:
 * - Reads optional process configuration without enforcing presence.
 */
function getEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Input:
 * - A Cloudflare account identifier.
 * Output:
 * - An authenticated S3-compatible R2 client.
 * What this function does:
 * - Configures the fast-path client from required R2 credentials.
 */
function buildS3Client(accountId: string): S3Client {
  const accessKeyId = getEnvOrThrow("R2_ACCESS_KEY_ID");
  const secretAccessKey = getEnvOrThrow("R2_SECRET_ACCESS_KEY");

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

/**
 * Input:
 * - Work items, maximum concurrency, and an asynchronous item worker.
 * Output:
 * - A promise that resolves after every item has been processed.
 * What this function does:
 * - Runs a fixed worker pool over a shared sequential cursor.
 */
async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;

  /**
   * Input:
   * - Shared items, cursor, and worker from the enclosing concurrency runner.
   * Output:
   * - A promise that resolves when this worker has exhausted available items.
   * What this function does:
   * - Claims one item at a time and delegates it to the supplied worker.
   */
  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      // Claim and advance synchronously before awaiting so concurrent workers cannot reuse an index.
      const current = cursor;
      cursor += 1;
      await worker(items[current], current);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
}

/**
 * Input:
 * - Enriched records and the local source root.
 * Output:
 * - Upload plan entries for all valid source records.
 * What this function does:
 * - Resolves local paths, raw keys, and index eligibility before uploading.
 */
function makePlan(records: EnrichedRecord[], sourceRoot: string): UploadPlanItem[] {
  const eligible = records.filter((record) => record.status !== "invalid_source");

  return eligible.map(
    /**
     * Input:
     * - One eligible enriched record.
     * Output:
     * - Its resolved raw and index upload instructions.
     * What this function does:
     * - Converts manifest metadata into an executable upload-plan item.
     */
    (record) => {
      const sourceAbsolutePath = path.join(sourceRoot, record.relative_path);
      return {
        record,
        sourceAbsolutePath,
        rawKey: sanitizeRawKey(record.relative_path),
        uploadIndexReady: record.status === "index_now",
      };
    },
  );
}

/**
 * Input:
 * - Parsed CLI configuration.
 * Output:
 * - Whether raw-object uploads are enabled.
 * What this function does:
 * - Applies index-only mode to raw upload selection.
 */
function shouldUploadRaw(config: CliConfig): boolean {
  return !config.indexOnly;
}

/**
 * Input:
 * - Parsed CLI configuration.
 * Output:
 * - Whether index-ready uploads are enabled.
 * What this function does:
 * - Applies raw-only mode to index upload selection.
 */
function shouldUploadIndex(config: CliConfig): boolean {
  return !config.rawOnly;
}

/**
 * Input:
 * - R2 client, destination, source file, metadata, and optional content type.
 * Output:
 * - A promise that resolves after the S3-compatible upload succeeds.
 * What this function does:
 * - Streams one local file to R2 through the authenticated fast path.
 */
async function uploadToBucket(
  client: S3Client,
  bucket: string,
  key: string,
  sourceFilePath: string,
  metadata: Record<string, string>,
  contentType?: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(sourceFilePath),
      ContentType: contentType,
      Metadata: metadata,
    }),
  );
}

/**
 * Input:
 * - R2 destination, source file path, and optional content type.
 * Output:
 * - A promise that resolves after Wrangler uploads the object.
 * What this function does:
 * - Uploads one object through the authenticated CLI fallback.
 */
async function uploadWithWrangler(bucket: string, key: string, sourceFilePath: string, contentType?: string): Promise<void> {
  const objectPath = `${bucket}/${key}`;
  const args = ["wrangler", "r2", "object", "put", objectPath, "--remote", "--file", sourceFilePath];
  if (contentType) {
    args.push("--content-type", contentType);
  }
  await execFileAsync("npx", args, {
    cwd: WORKDIR,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Input:
 * - CLI arguments, migration files, local source files, and R2 configuration.
 * Output:
 * - Uploaded objects plus a persisted run report, or dry-run console output.
 * What this function does:
 * - Plans, validates, executes, and reports the R2 migration run.
 */
async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  assertFileExists(config.manifestPath, "Manifest");
  assertFileExists(config.inventoryPath, "Inventory file");

  const manifest = readJsonFile<EnrichedRecord[]>(config.manifestPath);
  const inventory = readJsonFile<InventoryPayload>(config.inventoryPath);
  const sourceRoot = config.sourceRootOverride ?? inventory.root;

  const trimmedManifest = config.limit ? manifest.slice(0, config.limit) : manifest;
  const plan = makePlan(trimmedManifest, sourceRoot);
  const runMode = deriveRunMode(config);

  const totalBytes = plan.reduce((acc, item) => acc + item.record.size_bytes, 0);
  const indexReadyCount = plan.filter((item) => item.uploadIndexReady).length;

  console.log(`Mode: ${config.apply ? "APPLY" : "DRY-RUN"} (${runMode})`);
  console.log(`Manifest: ${config.manifestPath}`);
  console.log(`Source root: ${sourceRoot}`);
  console.log(`Files selected (excluding invalid_source): ${plan.length}`);
  console.log(`Index-ready mirror uploads: ${indexReadyCount}`);
  console.log(`Total bytes selected: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  const missingLocalFiles = plan.filter((item) => !fs.existsSync(item.sourceAbsolutePath));
  if (missingLocalFiles.length > 0) {
    console.warn(`WARNING: ${missingLocalFiles.length} files in manifest do not exist locally.`);
    for (const sample of missingLocalFiles.slice(0, 10)) {
      console.warn(`- Missing: ${sample.sourceAbsolutePath}`);
    }
  }

  if (!config.apply) {
    console.log("Dry-run complete. No uploads were performed.");
    return;
  }

  const accountId = getEnv("CLOUDFLARE_ACCOUNT_ID");
  const rawBucket = process.env.R2_BUCKET_RAW ?? "family-raw";
  const indexBucket = process.env.R2_BUCKET_INDEX_READY ?? "family-index-ready-v3";

  const hasS3Creds = Boolean(getEnv("R2_ACCESS_KEY_ID") && getEnv("R2_SECRET_ACCESS_KEY") && accountId);
  const client = hasS3Creds && accountId ? buildS3Client(accountId) : null;

  if (hasS3Creds) {
    console.log("Upload mode: S3 API (fast path with R2 credentials)");
  } else {
    console.log("Upload mode: Wrangler CLI fallback (no R2 keys found, slower)");
  }

  const errors: Array<{ path: string; error: string }> = [];
  let rawUploads = 0;
  let indexUploads = 0;
  const successfulRawPaths: string[] = [];
  const successfulIndexPaths: string[] = [];
  const skippedPaths: string[] = [];
  const startedAt = Date.now();

  await runWithConcurrency(
    plan,
    config.concurrency,
    /**
     * Input:
     * - One upload-plan item and its plan index.
     * Output:
     * - A promise that records successful, skipped, or failed upload outcomes.
     * What this function does:
     * - Uploads the selected raw and index copies for one source file.
     */
    async (item, idx) => {
      if (!fs.existsSync(item.sourceAbsolutePath)) {
        errors.push({ path: item.sourceAbsolutePath, error: "Local file missing" });
        return;
      }

      const contentType = inferContentType(item.record.extension);
      const metadata = {
        status: item.record.status,
        category: item.record.category,
        person: item.record.person,
        year: item.record.year,
        source_path: item.record.relative_path,
      };

      try {
        if (shouldUploadRaw(config)) {
          if (client) {
            await uploadToBucket(client, rawBucket, item.rawKey, item.sourceAbsolutePath, metadata, contentType);
          } else {
            // Preserve upload capability through Wrangler when direct R2 credentials are unavailable.
            await uploadWithWrangler(rawBucket, item.rawKey, item.sourceAbsolutePath, contentType);
          }
          rawUploads += 1;
          successfulRawPaths.push(item.record.relative_path);
        } else {
          skippedPaths.push(item.record.relative_path);
        }

        if (shouldUploadIndex(config) && item.uploadIndexReady) {
          if (client) {
            await uploadToBucket(client, indexBucket, item.record.target_r2_key, item.sourceAbsolutePath, metadata, contentType);
          } else {
            // Use the same fallback for the index mirror so run-mode semantics remain unchanged.
            await uploadWithWrangler(indexBucket, item.record.target_r2_key, item.sourceAbsolutePath, contentType);
          }
          indexUploads += 1;
          successfulIndexPaths.push(item.record.relative_path);
        }

        if ((idx + 1) % 25 === 0 || idx === plan.length - 1) {
          console.log(`Progress: ${idx + 1}/${plan.length} uploaded`);
        }
      } catch (error) {
        errors.push({ path: item.sourceAbsolutePath, error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  console.log("Upload complete.");
  console.log(`Raw uploads: ${rawUploads}`);
  console.log(`Index-ready uploads: ${indexUploads}`);
  console.log(`Errors: ${errors.length}`);
  const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const uploadedBytes = plan
    .filter((item) => fs.existsSync(item.sourceAbsolutePath))
    .reduce(
      /**
       * Input:
       * - Accumulated transferred bytes and one existing planned source file.
       * Output:
       * - Updated approximate bytes transferred across enabled destinations.
       * What this function does:
       * - Counts raw and mirrored index bytes for throughput reporting.
       */
      (acc, item) => {
        const rawBytes = shouldUploadRaw(config) ? item.record.size_bytes : 0;
        const indexBytes = shouldUploadIndex(config) && item.uploadIndexReady ? item.record.size_bytes : 0;
        return acc + rawBytes + indexBytes;
      },
      0,
    );
  console.log(`Elapsed: ${elapsedSec}s`);
  console.log(`Approx throughput: ${(uploadedBytes / 1024 / 1024 / elapsedSec).toFixed(2)} MB/s`);

  fs.mkdirSync(RUN_REPORT_DIR, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${runMode}`;
  const runReport: RunReport = {
    run_id: runId,
    mode: runMode,
    generated_at: new Date().toISOString(),
    apply: config.apply,
    manifest_path: config.manifestPath,
    source_root: sourceRoot,
    selected_records: plan.length,
    selected_bytes: totalBytes,
    selected_index_candidates: indexReadyCount,
    raw_bucket: rawBucket,
    index_bucket: indexBucket,
    raw_uploads: rawUploads,
    index_uploads: indexUploads,
    errors,
    successful_raw_paths: successfulRawPaths,
    successful_index_paths: successfulIndexPaths,
    skipped_paths: skippedPaths,
    elapsed_seconds: elapsedSec,
  };
  const runPath = path.join(RUN_REPORT_DIR, `${runId}.json`);
  fs.writeFileSync(runPath, JSON.stringify(runReport, null, 2));
  fs.writeFileSync(path.join(RUN_REPORT_DIR, `latest_${runMode}.json`), JSON.stringify(runReport, null, 2));
  console.log(`Run report written: ${runPath}`);

  if (errors.length > 0) {
    const errorOutputPath = path.join(WORKDIR, "outputs", "migration", "migration_upload_errors.json");
    fs.mkdirSync(path.dirname(errorOutputPath), { recursive: true });
    fs.writeFileSync(errorOutputPath, JSON.stringify(errors, null, 2));
    console.log(`Error details written to: ${errorOutputPath}`);
    process.exitCode = 1;
  }
}

main().catch(
  /**
   * Input:
   * - An unhandled migration failure.
   * Output:
   * - No return value; logs the failure and exits unsuccessfully.
   * What this function does:
   * - Converts top-level asynchronous failures into CLI error behavior.
   */
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
