// Hono's application type keeps route registration aligned with Worker bindings.
import type { Hono } from "hono";

// Policy rules determine whether an uploaded source can proceed to indexing.
import { decideProcessingStatus } from "../config/policy.js";

// Shared taxonomy values normalize aliases consistently across both upload APIs.
import {
  CANONICAL_CATEGORY_VALUES,
  isCanonicalCategory,
  normalizeCategory,
} from "../lib/categories.js";

// Classifier utilities derive safe filenames and default document metadata.
import { detectDocType, detectSensitivity, toCanonicalFilename } from "../lib/classifier.js";

// Shared domain types constrain uploader metadata and policy inputs.
import type { CatalogCategory, InventoryRecord, PersonTag, Sensitivity } from "../lib/types.js";

// Storage names and the search payload limit mirror the deployed Family AI resources.
const RAW_BUCKET_NAME = "family-raw";
const INDEX_BUCKET_NAME = "family-index-ready-v3";
const AI_SEARCH_MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;

// These option lists are the accepted metadata values exposed by the uploader API.
const KNOWN_CATEGORIES = CANONICAL_CATEGORY_VALUES;
const PEOPLE = ["oskar", "kaitlin", "zadia", "baby2", "shared"] as const;
const SENSITIVITIES = ["restricted", "family", "shared"] as const;

// Direct extensions are stored in index-ready as-is when policy and size permit.
const DIRECT_INDEXABLE_EXTENSIONS = new Set(["pdf", "docx", "doc", "txt", "md", "markdown", "html", "csv", "json", "xml", "yaml", "yml", "xlsx", "pptx"]);
// Family policy intentionally excludes video/photo/archive-style files from text indexing.
const EXCLUDED_FROM_INDEXING_EXTENSIONS = new Set(["mov", "mp4", "m4a", "mp3", "jpg", "jpeg", "png", "heic", "zip", "7z", "crdownload", "plist", "(no_ext)"]);

// Indexing modes describe whether the search copy is original, transformed, or absent.
type IndexingMode = "direct" | "converted" | "skipped";

// Conversion metadata records how an index-ready representation differs from its source.
type ConversionDetails = {
  source_extension: string;
  target_extension: string;
  strategy: "none" | "rtf_to_text" | "text_to_text";
} | null;

// UploadInput is the normalized request shape shared by preview and save operations.
export type UploadInput = {
  file: File | null;
  source_path: string;
  filename: string;
  extension: string;
  size_bytes: number;
  mime_type: string | null;
  approved_by: string;
  category: string | null;
  custom_category: string | null;
  year: string | null;
  person: string | null;
  doc_type: string | null;
  sensitivity: string | null;
  is_confirmed: boolean;
};

// IndexObject describes the optional payload destined for the index-ready bucket.
type IndexObject = {
  key: string;
  body: ArrayBuffer | string;
  contentType: string;
  mode: IndexingMode;
  note: string;
  conversionDetails: ConversionDetails;
};

// UploadPlan captures every validated storage and indexing decision before persistence.
export type UploadPlan = {
  categoryKey: string;
  customCategoryLabel: string | null;
  year: string;
  person: PersonTag;
  docType: string;
  sensitivity: Sensitivity;
  policyStatus: string;
  policyReason: string;
  effectiveStatus: string;
  effectiveReason: string;
  indexingMode: IndexingMode;
  indexingNote: string;
  conversionDetails: ConversionDetails;
  wouldIndex: boolean;
  blockedReason: "policy_block" | "unsupported_format" | "size_limit" | null;
  checksumHex: string;
  rawKey: string;
  indexKey: string | null;
  indexObject: IndexObject | null;
};

// DocumentRow mirrors the D1 columns needed to build public document summaries.
type DocumentRow = {
  doc_id: string;
  source_local_path: string;
  source_size_bytes: number;
  extension: string;
  mime_type: string | null;
  category: string;
  subcategory: string | null;
  doc_type: string;
  year: string;
  person: string;
  sensitivity: string;
  status: string;
  status_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Input:
 * - A filename and an optional extension supplied by the caller.
 * Output:
 * - A lowercase extension without a leading dot, or "(no_ext)".
 * What this function does:
 * - Chooses the supplied extension or reads it from the filename.
 */
function inferExtension(filename: string, supplied: string | null): string {
  if (supplied && supplied.trim().length > 0) return supplied.replace(/^\./, "").toLowerCase();
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "(no_ext)";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Input:
 * - Raw bytes, usually from a file checksum.
 * Output:
 * - The same bytes written as a hexadecimal string.
 * What this function does:
 * - Makes binary checksum data safe to store and display as text.
 */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Input:
 * - An R2 object key and a hexadecimal checksum.
 * Output:
 * - An object key with a short checksum added before the file extension.
 * What this function does:
 * - Prevents files with the same name from using the same storage key.
 */
function uniqueKeyWithChecksum(baseKey: string, checksumHex: string): string {
  const slash = baseKey.lastIndexOf("/");
  const filename = slash >= 0 ? baseKey.slice(slash + 1) : baseKey;
  const folder = slash >= 0 ? baseKey.slice(0, slash) : "";
  const dot = filename.lastIndexOf(".");
  const suffix = `__${checksumHex.slice(0, 8)}`;
  const uniqueFile = dot > 0 ? `${filename.slice(0, dot)}${suffix}${filename.slice(dot)}` : `${filename}${suffix}`;
  return folder ? `${folder}/${uniqueFile}` : uniqueFile;
}

/**
 * Input:
 * - A file path and a new extension without a dot.
 * Output:
 * - The path with its extension replaced or added.
 * What this function does:
 * - Creates the output filename used for converted index files.
 */
function replaceExtension(path: string, newExt: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return `${path}.${newExt}`;
  return `${path.slice(0, dot)}.${newExt}`;
}

/**
 * Input:
 * - Text containing basic RTF formatting codes.
 * Output:
 * - A simplified plain-text version of the content.
 * What this function does:
 * - Removes common RTF controls so search can read the words.
 */
function stripRtfToText(rtf: string): string {
  return rtf
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\\[a-z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Input:
 * - Raw file bytes.
 * Output:
 * - Lossy UTF-8 text, or null if decoding throws unexpectedly.
 * What this function does:
 * - Decodes a file buffer as text while replacing malformed byte sequences.
 */
function textFromBuffer(buffer: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * Input:
 * - A raw storage key, file format details, and the file bytes.
 * Output:
 * - An index-ready object plan, or null when the format is unsupported.
 * What this function does:
 * - Routes each file format to direct indexing, text conversion, or skipping.
 */
function buildIndexObject(rawKey: string, extension: string, mimeType: string | null, fileBuffer: ArrayBuffer): IndexObject | null {
  const ext = extension.toLowerCase();
  // Stop formats that family policy treats as media, archives, or incomplete files.
  if (EXCLUDED_FROM_INDEXING_EXTENSIONS.has(ext)) return null;

  // Prefer lossless indexing for known-friendly formats.
  if (DIRECT_INDEXABLE_EXTENSIONS.has(ext)) {
    return {
      key: rawKey,
      body: fileBuffer,
      contentType: mimeType || "application/octet-stream",
      mode: "direct",
      note: "Stored directly in index-ready bucket.",
      conversionDetails: { source_extension: ext, target_extension: ext, strategy: "none" },
    };
  }

  // Remaining formats can continue only when decoding produces usable text.
  const decoded = textFromBuffer(fileBuffer);
  if (!decoded) return null;

  if (ext === "rtf") {
    // RTF gets normalized to plain text to improve search quality.
    const text = stripRtfToText(decoded);
    if (!text) return null;
    return {
      key: replaceExtension(rawKey, "txt"),
      body: text,
      contentType: "text/plain; charset=utf-8",
      mode: "converted",
      note: "Converted RTF to plain text for indexing.",
      conversionDetails: { source_extension: ext, target_extension: "txt", strategy: "rtf_to_text" },
    };
  }

  if (mimeType?.startsWith("text/") || ["log", "ini", "cfg", "conf", "jsonc"].includes(ext)) {
    return {
      key: replaceExtension(rawKey, "txt"),
      body: decoded,
      contentType: "text/plain; charset=utf-8",
      mode: "converted",
      note: "Converted text-like file to plain text for indexing.",
      conversionDetails: { source_extension: ext, target_extension: "txt", strategy: "text_to_text" },
    };
  }

  return null;
}

/**
 * Input:
 * - An index-ready object containing text or raw bytes.
 * Output:
 * - The object's size in bytes.
 * What this function does:
 * - Measures the final payload before applying the search size limit.
 */
function indexObjectSizeBytes(indexObject: IndexObject): number {
  if (typeof indexObject.body === "string") {
    return new TextEncoder().encode(indexObject.body).byteLength;
  }
  return indexObject.body.byteLength;
}

/**
 * Input:
 * - No arguments; the current UTC year comes from the clock.
 * Output:
 * - "unknown" followed by years from the current year down to 2000.
 * What this function does:
 * - Builds the year choices shown by the uploader API.
 */
function buildYearOptions(): string[] {
  const currentYear = new Date().getUTCFullYear();
  const years = ["unknown"];
  for (let year = currentYear; year >= 2000; year -= 1) years.push(String(year));
  return years;
}

/**
 * Input:
 * - A category name.
 * Output:
 * - True when the category is one of the built-in choices.
 * What this function does:
 * - Checks and narrows category values before they are used.
 */
function isKnownCategory(value: string): value is (typeof KNOWN_CATEGORIES)[number] {
  return isCanonicalCategory(value);
}

/**
 * Input:
 * - A person label.
 * Output:
 * - True when the label is an allowed family person tag.
 * What this function does:
 * - Checks and narrows person values before they are stored.
 */
function isPersonTag(value: string): value is PersonTag {
  return PEOPLE.includes(value as PersonTag);
}

/**
 * Input:
 * - A sensitivity label.
 * Output:
 * - True when the label is an allowed sensitivity value.
 * What this function does:
 * - Checks and narrows sensitivity values before they are stored.
 */
function isSensitivity(value: string): value is Sensitivity {
  return SENSITIVITIES.includes(value as Sensitivity);
}

/**
 * Input:
 * - A user-provided custom category name.
 * Output:
 * - A short lowercase key containing only safe characters.
 * What this function does:
 * - Turns a display label into a safe storage and path key.
 */
function sanitizeCustomCategory(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "").replace(/-+/g, "-").slice(0, 60);
}

/**
 * Input:
 * - Parsed upload metadata.
 * Output:
 * - The smaller inventory record required by the processing policy.
 * What this function does:
 * - Adapts uploader data to the policy engine's expected shape.
 */
function makeInventoryRecord(input: UploadInput): InventoryRecord {
  return {
    top_folder: "uploaded",
    folder: "uploaded",
    filename: input.filename,
    relative_path: input.source_path,
    extension: input.extension,
    size_bytes: input.size_bytes,
  };
}

/**
 * Input:
 * - Upload metadata with a built-in or custom category.
 * Output:
 * - A category key and optional display label, or null when invalid.
 * What this function does:
 * - Validates built-in categories and safely prepares custom ones.
 */
function resolveCategory(input: UploadInput): { key: string; customLabel: string | null } | null {
  const normalized = normalizeCategory(input.category);
  if (normalized) return { key: normalized, customLabel: null };
  if (input.custom_category) {
    const key = sanitizeCustomCategory(input.custom_category);
    if (!key) return null;
    const normalizedCustom = normalizeCategory(key);
    if (normalizedCustom) return { key: normalizedCustom, customLabel: null };
    if (key === "family") return null;
    return { key, customLabel: input.custom_category.trim() };
  }
  return null;
}

/**
 * Input:
 * - Upload metadata containing a year choice.
 * Output:
 * - A valid four-digit year, "unknown", or null.
 * What this function does:
 * - Validates the year before it is used in metadata and paths.
 */
function resolveYear(input: UploadInput): string | null {
  if (!input.year) return null;
  if (input.year === "unknown") return "unknown";
  return /^20\d{2}$/.test(input.year) ? input.year : null;
}

/**
 * Input:
 * - Upload metadata containing a person choice.
 * Output:
 * - A valid person tag, or null.
 * What this function does:
 * - Validates who the uploaded document belongs to.
 */
function resolvePerson(input: UploadInput): PersonTag | null {
  if (!input.person) return null;
  return isPersonTag(input.person) ? input.person : null;
}

/**
 * Input:
 * - Upload metadata and the source filename information.
 * Output:
 * - A caller-provided or automatically detected document type.
 * What this function does:
 * - Chooses a useful document type for classification and storage.
 */
function resolveDocType(input: UploadInput): string {
  if (input.doc_type && input.doc_type.trim().length > 0) return input.doc_type.trim();
  return detectDocType(`${input.source_path}/${input.filename}`, input.extension);
}

/**
 * Input:
 * - Upload metadata and its resolved category key.
 * Output:
 * - A caller-provided or automatically detected sensitivity level.
 * What this function does:
 * - Chooses the privacy level applied to the document.
 */
function resolveSensitivity(input: UploadInput, categoryKey: string): Sensitivity {
  if (input.sensitivity && isSensitivity(input.sensitivity)) return input.sensitivity;
  if (isKnownCategory(categoryKey)) return detectSensitivity(categoryKey as CatalogCategory);
  return "family";
}

/**
 * Input:
 * - Confirmed upload metadata and the uploaded file bytes.
 * Output:
 * - A complete upload plan, or a validation error with HTTP status 400.
 * What this function does:
 * - Validates metadata and plans storage, conversion, and indexing without saving anything.
 */
export async function buildUploadPlan(input: UploadInput, fileBuffer: ArrayBuffer): Promise<{ plan: UploadPlan } | { error: string; status: 400 }> {
  // Validate user-confirmed metadata before doing checksum or storage-path work.
  if (!input.is_confirmed) {
    return { error: "Please confirm metadata before continuing (is_confirmed=true)", status: 400 };
  }

  const categoryResolved = resolveCategory(input);
  if (!categoryResolved) {
    return { error: "Provide category from options or custom_category", status: 400 };
  }

  const year = resolveYear(input);
  if (!year) {
    return { error: "Provide a valid year (YYYY) or unknown", status: 400 };
  }

  const person = resolvePerson(input);
  if (!person) {
    return { error: "Provide person from allowed options", status: 400 };
  }

  const docType = resolveDocType(input);
  const sensitivity = resolveSensitivity(input, categoryResolved.key);
  const record = makeInventoryRecord(input);
  const policy = decideProcessingStatus(record);

  // The checksum makes the raw key stable and avoids collisions between same-named files.
  const checksumHex = toHex(await crypto.subtle.digest("SHA-256", fileBuffer));
  const baseKey = `${categoryResolved.key}/${year}/${person}/${docType}/${toCanonicalFilename(input.filename)}`;
  const rawKey = uniqueKeyWithChecksum(baseKey, checksumHex);

  let indexKey: string | null = null;
  let effectiveStatus = policy.status;
  let effectiveReason = policy.reason;
  let indexingMode: IndexingMode = "skipped";
  let indexingNote = "File was not indexed based on policy and conversion support.";
  let conversionDetails: ConversionDetails = null;
  let blockedReason: UploadPlan["blockedReason"] = null;

  // Combine policy, format support, and final payload size into one explainable index decision.
  const policyBlocksAutoIndex = new Set(["store_only", "invalid_source", "split_then_index", "ocr_then_index", "extract_then_classify"]);
  const indexObject = buildIndexObject(rawKey, input.extension, input.mime_type, fileBuffer);
  // Keep this decision tree explicit so preview/save can explain exactly why indexing is blocked.
  if (!indexObject) {
    blockedReason = "unsupported_format";
    indexingNote = "No supported direct/converted index payload for this file format.";
  } else if (policyBlocksAutoIndex.has(policy.status)) {
    blockedReason = "policy_block";
    indexingNote = `Policy status ${policy.status} blocks auto indexing at upload time.`;
  } else {
    const payloadSize = indexObjectSizeBytes(indexObject);
    if (payloadSize > AI_SEARCH_MAX_FILE_SIZE_BYTES) {
      blockedReason = "size_limit";
      indexingNote = `Converted/index payload exceeds AI Search 4MB limit (${payloadSize} bytes).`;
    } else {
      indexKey = indexObject.key;
      indexingMode = indexObject.mode;
      indexingNote = indexObject.note;
      conversionDetails = indexObject.conversionDetails;
      effectiveStatus = "index_now";
      effectiveReason = policy.status === "index_now" ? policy.reason : `${policy.reason} Converted for indexing.`;
    }
  }

  return {
    plan: {
      categoryKey: categoryResolved.key,
      customCategoryLabel: categoryResolved.customLabel,
      year,
      person,
      docType,
      sensitivity,
      policyStatus: policy.status,
      policyReason: policy.reason,
      effectiveStatus,
      effectiveReason,
      indexingMode,
      indexingNote,
      conversionDetails,
      wouldIndex: !!indexKey,
      blockedReason,
      checksumHex,
      rawKey,
      indexKey,
      indexObject,
    },
  };
}

/**
 * Input:
 * - An HTTP request containing multipart form data or JSON.
 * Output:
 * - Upload fields normalized into one UploadInput object.
 * What this function does:
 * - Parses both supported request formats and applies basic defaults.
 */
async function readUploadInput(request: Request): Promise<UploadInput> {
  const contentType = request.headers.get("content-type") || "";
  const approvedByDefault = "family-user";

  if (contentType.includes("multipart/form-data")) {
    // Multipart requests carry the real file plus text fields from the uploader form.
    const form = await request.formData();
    const fileValue = form.get("file");
    const file = fileValue instanceof File ? fileValue : null;
    const sourcePath = String(form.get("source_path") || file?.name || "uploaded/unknown");
    const filename = String(form.get("filename") || file?.name || "unknown");
    const extension = inferExtension(filename, form.get("extension") ? String(form.get("extension")) : null);

    return {
      file,
      source_path: sourcePath,
      filename,
      extension,
      size_bytes: file ? file.size : Number(form.get("size_bytes") || 0),
      mime_type: String(form.get("mime_type") || file?.type || "").trim() || null,
      approved_by: String(form.get("approved_by") || approvedByDefault),
      category: String(form.get("category") || "").trim() || null,
      custom_category: String(form.get("custom_category") || "").trim() || null,
      year: String(form.get("year") || "").trim() || null,
      person: String(form.get("person") || "").trim() || null,
      doc_type: String(form.get("doc_type") || "").trim() || null,
      sensitivity: String(form.get("sensitivity") || "").trim() || null,
      is_confirmed: String(form.get("is_confirmed") || "false").toLowerCase() === "true",
    };
  }

  // JSON requests can describe metadata but cannot provide a File object for preview or save.
  const body = (await request.json()) as Record<string, unknown>;
  const filename = String(body.filename || "unknown");
  return {
    file: null,
    source_path: String(body.source_path || filename),
    filename,
    extension: inferExtension(filename, body.extension ? String(body.extension) : null),
    size_bytes: Number(body.size_bytes || 0),
    mime_type: body.mime_type ? String(body.mime_type) : null,
    approved_by: body.approved_by ? String(body.approved_by) : approvedByDefault,
    category: body.category ? String(body.category) : null,
    custom_category: body.custom_category ? String(body.custom_category) : null,
    year: body.year ? String(body.year) : null,
    person: body.person ? String(body.person) : null,
    doc_type: body.doc_type ? String(body.doc_type) : null,
    sensitivity: body.sensitivity ? String(body.sensitivity) : null,
    is_confirmed: body.is_confirmed === true,
  };
}

/**
 * Input:
 * - A query-string value and a fallback number.
 * Output:
 * - A whole positive number, or the fallback when the value is invalid.
 * What this function does:
 * - Safely parses pagination values from URL parameters.
 */
function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Input:
 * - A full document row from D1.
 * Output:
 * - The public document summary returned by uploader endpoints.
 * What this function does:
 * - Selects and renames fields for a consistent API response.
 */
function toDocumentSummary(row: DocumentRow) {
  return {
    doc_id: row.doc_id,
    source_local_path: row.source_local_path,
    extension: row.extension,
    category: row.category,
    custom_category_label: row.subcategory,
    doc_type: row.doc_type,
    year: row.year,
    person: row.person,
    sensitivity: row.sensitivity,
    status: row.status,
    status_reason: row.status_reason,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Input:
 * - The Hono application that should receive uploader routes.
 * Output:
 * - No return value; the application is updated with route registrations.
 * What this function does:
 * - Adds uploader option, document, preview, and save endpoints.
 */
export function registerUploaderApi(app: Hono<{ Bindings: Env }>): void {
  app.get(
    "/api/uploader/options",
    /**
     * Input:
     * - A Hono request context.
     * Output:
     * - JSON containing the uploader's allowed metadata options.
     * What this function does:
     * - Gives clients the choices needed to build an upload form.
     */
    (c) => {
    return c.json({
      ok: true,
      options: {
        categories: [...KNOWN_CATEGORIES],
        allow_custom_category: true,
        years: buildYearOptions(),
        people: [...PEOPLE],
        sensitivities: [...SENSITIVITIES],
      },
    });
    });

  app.get(
    "/api/uploader/documents",
    /**
     * Input:
     * - A Hono context with optional pagination and filter query parameters.
     * Output:
     * - JSON containing a filtered page of documents and the total count.
     * What this function does:
     * - Lists uploaded document metadata from D1.
     */
    async (c) => {
    const limit = Math.min(parsePositiveInt(c.req.query("limit") ?? null, 20), 100);
    const offset = parsePositiveInt(c.req.query("offset") ?? null, 0);
    const category = c.req.query("category")?.trim() || null;
    const person = c.req.query("person")?.trim() || null;
    const status = c.req.query("status")?.trim() || null;

    // Build only the requested WHERE clauses and keep all user values parameterized.
    const where: string[] = [];
    const params: unknown[] = [];
    if (category) {
      where.push("category = ?");
      params.push(category);
    }
    if (person) {
      where.push("person = ?");
      params.push(person);
    }
    if (status) {
      where.push("status = ?");
      params.push(status);
    }

    // The same dynamic filter must be used by both the page query and total-count query.
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const listStmt = c.env.DB.prepare(
      `SELECT
        doc_id, source_local_path, source_size_bytes, extension, mime_type,
        category, subcategory, doc_type, year, person, sensitivity,
        status, status_reason, approved_by, approved_at, created_at, updated_at
      FROM documents
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset);

    const countStmt = c.env.DB.prepare(`SELECT COUNT(*) as total_count FROM documents ${whereSql}`).bind(...params);
    const [listRes, countRes] = await c.env.DB.batch([listStmt, countStmt]);
    const rows = (listRes.results || []) as unknown as DocumentRow[];
    const total = Number((countRes.results?.[0] as { total_count?: number } | undefined)?.total_count || 0);

    return c.json({
      ok: true,
      pagination: {
        limit,
        offset,
        total,
      },
      documents: rows.map(toDocumentSummary),
    });
    });

  app.get(
    "/api/uploader/documents/:doc_id",
    /**
     * Input:
     * - A Hono context containing a document ID path parameter.
     * Output:
     * - JSON containing the document and its latest version, or a 404 error.
     * What this function does:
     * - Loads one document's current metadata and storage references.
     */
    async (c) => {
    const docId = c.req.param("doc_id");
    const docRes = await c.env.DB.prepare(
      `SELECT
        doc_id, source_local_path, source_size_bytes, extension, mime_type,
        category, subcategory, doc_type, year, person, sensitivity,
        status, status_reason, approved_by, approved_at, created_at, updated_at
      FROM documents
      WHERE doc_id = ?
      LIMIT 1`
    )
      .bind(docId)
      .all<DocumentRow>();

    const doc = docRes.results?.[0];
    if (!doc) {
      return c.json({ ok: false, error: "Document not found" }, 404);
    }

    const versionRes = await c.env.DB.prepare(
      `SELECT
        version_id, source_version, r2_raw_bucket, r2_raw_key,
        r2_index_bucket, r2_index_key, r2_processed_bucket, r2_processed_key,
        created_at
      FROM document_versions
      WHERE doc_id = ?
      ORDER BY created_at DESC
      LIMIT 1`
    )
      .bind(docId)
      .all();

    return c.json({
      ok: true,
      document: toDocumentSummary(doc),
      latest_version: versionRes.results?.[0] || null,
    });
    });

  app.patch(
    "/api/uploader/documents/:doc_id",
    /**
     * Input:
     * - A Hono context with a document ID and partial metadata JSON.
     * Output:
     * - JSON describing the saved metadata, or a validation/not-found error.
     * What this function does:
     * - Validates and merges editable metadata into an existing document.
     */
    async (c) => {
    const docId = c.req.param("doc_id");
    const body = (await c.req.json()) as Record<string, unknown>;

    const existingRes = await c.env.DB.prepare("SELECT doc_id, category, subcategory, year, person, doc_type, sensitivity FROM documents WHERE doc_id = ? LIMIT 1")
      .bind(docId)
      .all<{ doc_id: string; category: string; subcategory: string | null; year: string; person: string; doc_type: string; sensitivity: string }>();
    const existing = existingRes.results?.[0];
    if (!existing) {
      return c.json({ ok: false, error: "Document not found" }, 404);
    }

    // Merge omitted PATCH fields with stored values before reusing upload validators.
    const patchInput: UploadInput = {
      file: null,
      source_path: "patch",
      filename: "patch",
      extension: "txt",
      size_bytes: 1,
      mime_type: "text/plain",
      approved_by: typeof body.approved_by === "string" && body.approved_by.trim() ? body.approved_by : "family-user",
      category: typeof body.category === "string" ? body.category : null,
      custom_category: typeof body.custom_category === "string" ? body.custom_category : null,
      year: typeof body.year === "string" ? body.year : existing.year,
      person: typeof body.person === "string" ? body.person : existing.person,
      doc_type: typeof body.doc_type === "string" ? body.doc_type : existing.doc_type,
      sensitivity: typeof body.sensitivity === "string" ? body.sensitivity : existing.sensitivity,
      is_confirmed: true,
    };

    // A supplied category is validated; otherwise the existing category pair stays unchanged.
    const categoryResolved = patchInput.category || patchInput.custom_category ? resolveCategory(patchInput) : { key: existing.category, customLabel: existing.subcategory };
    if (!categoryResolved) {
      return c.json({ ok: false, error: "Invalid category/custom_category" }, 400);
    }
    const year = resolveYear(patchInput);
    if (!year) {
      return c.json({ ok: false, error: "Provide a valid year (YYYY) or unknown" }, 400);
    }
    const person = resolvePerson(patchInput);
    if (!person) {
      return c.json({ ok: false, error: "Provide person from allowed options" }, 400);
    }
    const docType = patchInput.doc_type?.trim() || existing.doc_type;
    const sensitivity = resolveSensitivity(patchInput, categoryResolved.key);
    const now = new Date().toISOString();
    const approvedBy = patchInput.approved_by;

    // Save the fully validated merged values as one metadata update.
    await c.env.DB.prepare(
      `UPDATE documents
       SET category = ?, subcategory = ?, year = ?, person = ?, doc_type = ?, sensitivity = ?,
           approved_by = ?, approved_at = ?, updated_at = ?
       WHERE doc_id = ?`
    )
      .bind(categoryResolved.key, categoryResolved.customLabel, year, person, docType, sensitivity, approvedBy, now, now, docId)
      .run();

    return c.json({
      ok: true,
      doc_id: docId,
      updated: {
        category: categoryResolved.key,
        custom_category_label: categoryResolved.customLabel,
        year,
        person,
        doc_type: docType,
        sensitivity,
        approved_by: approvedBy,
        approved_at: now,
      },
    });
    });

  app.post(
    "/api/uploader/preview",
    /**
     * Input:
     * - A Hono context containing a multipart file upload and metadata.
     * Output:
     * - JSON showing what storage and indexing actions would occur.
     * What this function does:
     * - Builds and returns an upload plan without saving the file.
     */
    async (c) => {
    const input = await readUploadInput(c.req.raw);
    if (!input.file) return c.json({ ok: false, error: "multipart/form-data with file is required" }, 400);

    const fileBuffer = await input.file.arrayBuffer();
    const planned = await buildUploadPlan(input, fileBuffer);
    if ("error" in planned) {
      return c.json({ ok: false, error: planned.error }, planned.status);
    }

    const { plan } = planned;
    return c.json({
      ok: true,
      preview: {
        would_index: plan.wouldIndex,
        blocked_reason: plan.blockedReason,
        indexing_mode: plan.indexingMode,
        indexing_note: plan.indexingNote,
        conversion_details: plan.conversionDetails,
        raw_key: plan.rawKey,
        index_key: plan.indexKey,
        policy: {
          status: plan.policyStatus,
          reason: plan.policyReason,
        },
        metadata: {
          category: plan.categoryKey,
          custom_category_label: plan.customCategoryLabel,
          year: plan.year,
          person: plan.person,
          doc_type: plan.docType,
          sensitivity: plan.sensitivity,
        },
      },
    });
    });

  app.post(
    "/api/uploader/save",
    /**
     * Input:
     * - A Hono context containing a confirmed multipart file upload and metadata.
     * Output:
     * - A 201 JSON response with document, version, storage, and indexing details.
     * What this function does:
     * - Saves the file and records, then queues its next processing stage.
     */
    async (c) => {
    const input = await readUploadInput(c.req.raw);
    if (!input.file) return c.json({ ok: false, error: "multipart/form-data with file is required" }, 400);

    const fileBuffer = await input.file.arrayBuffer();
    const planned = await buildUploadPlan(input, fileBuffer);
    if ("error" in planned) {
      return c.json({ ok: false, error: planned.error }, planned.status);
    }

    const { plan } = planned;
    const docId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const rawKey = plan.rawKey;

    // Always preserve the original bytes in raw storage before writing metadata records.
    await c.env.R2_RAW.put(rawKey, fileBuffer, {
      httpMetadata: input.mime_type ? { contentType: input.mime_type } : undefined,
    });

    // Save a second index-ready object only when the upload plan approved one.
    if (plan.indexKey && plan.indexObject) {
      await c.env.R2_INDEX_READY.put(plan.indexKey, plan.indexObject.body, {
        httpMetadata: { contentType: plan.indexObject.contentType },
      });
    }

    // Record the document and its first version together so D1 stays internally consistent.
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO documents (
          doc_id, source_local_path, source_checksum, source_size_bytes, extension, mime_type,
        category, subcategory, doc_type, year, person, sensitivity, status, status_reason,
        classification_confidence, approved_by_user, approved_by, approved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      ).bind(
        docId,
        input.source_path,
        `sha256:${plan.checksumHex}`,
        input.size_bytes,
        input.extension,
        input.mime_type,
        plan.categoryKey,
        plan.customCategoryLabel,
        plan.docType,
        plan.year,
        plan.person,
        plan.sensitivity,
        plan.effectiveStatus,
        `${plan.effectiveReason} ${plan.indexingNote}`.trim(),
        1,
        input.approved_by,
        now,
        now,
        now
      ),
      c.env.DB.prepare(
        `INSERT INTO document_versions (
          version_id, doc_id, source_version, r2_raw_bucket, r2_raw_key,
          r2_index_bucket, r2_index_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(versionId, docId, `sha256:${plan.checksumHex}`, RAW_BUCKET_NAME, rawKey, plan.indexKey ? INDEX_BUCKET_NAME : null, plan.indexKey, now),
    ]);

    // Queue follow-up work after durable R2 and D1 saves without delaying the response.
    c.executionCtx.waitUntil(
      c.env.PROCESSING_QUEUE.send({
        job_id: crypto.randomUUID(),
        doc_id: docId,
        stage: plan.indexKey ? "index_ready" : "post_upload",
        status: "queued",
        created_at: now,
      })
    );

    return c.json(
      {
        ok: true,
        doc_id: docId,
        version_id: versionId,
        status: plan.effectiveStatus,
        status_reason: plan.effectiveReason,
        raw_key: rawKey,
        index_key: plan.indexKey,
        indexing_mode: plan.indexingMode,
        indexing_note: plan.indexingNote,
        conversion_details: plan.conversionDetails,
        metadata: {
          category: plan.categoryKey,
          custom_category_label: plan.customCategoryLabel,
          year: plan.year,
          person: plan.person,
          doc_type: plan.docType,
          sensitivity: plan.sensitivity,
        },
      },
      201
    );
    });
}
