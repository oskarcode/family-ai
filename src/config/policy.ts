// Shared source and status types define the policy engine's input and output vocabulary.
import type { InventoryRecord, ProcessingStatus } from "../lib/types.js";

// This threshold matches the maximum file size accepted by the downstream search index.
const AI_SEARCH_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

// Extension groups route known formats to storage, transformation, indexing, or rejection.
const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4a", "mp3"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic"]);
const DOC_EXTENSIONS = new Set(["pdf", "docx", "doc", "txt", "md", "markdown", "rtf", "html", "csv", "json", "xml", "yaml", "yml", "xlsx", "numbers", "pages", "pptx"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "7z"]);
const INVALID_EXTENSIONS = new Set(["crdownload", "plist", "(no_ext)"]);

// These filenames identify operating-system artifacts rather than family documents.
const SYSTEM_FILENAMES = new Set([".DS_Store", "-"]);

// Path hints distinguish scanned documents from personal photo collections.
const DOCUMENT_IMAGE_HINTS = ["scan", "scanner", "camscanner", "passport", "id", "statement", "form", "result", "test", "medical", "tax"];
const PURE_PHOTO_PATH_HINTS = ["/photos", "/songs", "newborn", "favorite-download"];

// PolicyResult pairs a machine-readable workflow state with its user-facing rationale.
type PolicyResult = {
  status: ProcessingStatus;
  reason: string;
};

/**
 * Input:
 * - A source path that may describe a scanned or administrative image.
 * Output:
 * - Whether the path contains a document-oriented filename hint.
 * What this function does:
 * - Classifies images that are likely documents rather than ordinary photos.
 */
function looksLikeDocumentImage(path: string): boolean {
  const lower = path.toLowerCase();
  return DOCUMENT_IMAGE_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Input:
 * - A source path that may belong to a photo-oriented directory.
 * Output:
 * - Whether the path matches a known pure-photo location hint.
 * What this function does:
 * - Identifies media paths that should remain storage-only.
 */
function isPurePhoto(path: string): boolean {
  const lower = path.toLowerCase();
  return PURE_PHOTO_PATH_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Input:
 * - An inventory record containing source type, path, filename, and size metadata.
 * Output:
 * - The processing status and human-readable reason selected for the record.
 * What this function does:
 * - Applies migration policy precedence to choose storage, indexing, transformation, or review handling.
 */
export function decideProcessingStatus(record: InventoryRecord): PolicyResult {
  const ext = record.extension.toLowerCase();
  const path = record.relative_path;

  // Resolve terminal source and archive cases before evaluating media or document eligibility.
  if (SYSTEM_FILENAMES.has(record.filename) || INVALID_EXTENSIONS.has(ext)) {
    return { status: "invalid_source", reason: "System artifact, partial download, or extensionless file." };
  }

  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return { status: "extract_then_classify", reason: "Archive file must be extracted before indexing policy can be applied." };
  }

  if (VIDEO_EXTENSIONS.has(ext)) {
    return { status: "store_only", reason: "Video/audio is stored in R2 but excluded from indexing by current policy." };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    // Prefer explicit photo-path exclusions, then reconcile size limits with document-image hints.
    if (isPurePhoto(path)) {
      return { status: "store_only", reason: "Pure photo media is stored but excluded from indexing." };
    }

    if (record.size_bytes > AI_SEARCH_SIZE_LIMIT_BYTES) {
      if (looksLikeDocumentImage(path)) {
        return { status: "ocr_then_index", reason: "Likely document screenshot/scanned image over size limit; OCR + transform in Phase 2." };
      }
      return { status: "store_only", reason: "Large non-document image stays storage-only." };
    }

    if (looksLikeDocumentImage(path)) {
      return { status: "index_now", reason: "Document-like image under size limit is eligible for indexing." };
    }

    return { status: "store_only", reason: "Non-document image is storage-only by policy." };
  }

  if (DOC_EXTENSIONS.has(ext)) {
    // Eligible document types cross into Phase 2 only when they exceed the indexing size limit.
    if (record.size_bytes > AI_SEARCH_SIZE_LIMIT_BYTES) {
      return { status: "split_then_index", reason: "Document exceeds AI Search 4MB limit and needs split/transform in Phase 2." };
    }
    return { status: "index_now", reason: "Document type and size are index-eligible." };
  }

  return { status: "manual_review", reason: "Unknown file type; requires manual decision." };
}
