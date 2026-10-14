// Shared classifier helpers derive canonical filenames and document types.
import { detectDocType, toCanonicalFilename } from "../lib/classifier.js";

// Cloudflare API helpers upload documents through the AI Search binding.
import { uploadItemToAiSearch } from "./cloudflare-api.js";

// Ingestion limits and format allowlists enforce the Family AI upload contract.
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
} from "./config.js";

// File utilities normalize metadata, bytes, signatures, and index artifacts.
import {
  decodeBase64ToBytes,
  encodeBytesToBase64,
  fromBase64Url,
  hasUnsafeFilenameSegments,
  hmacSha256Hex,
  inferExtension,
  isMimeCompatible,
  sanitizeCategory,
  sanitizePerson,
  sanitizeSensitivity,
  sanitizeYear,
  toBase64Url,
  toHex,
} from "./file-utils.js";

// Shared types define Worker bindings and the inputs and results used by tools.
import type { ChatGptFileInput, EnvBindings, GeneratedTextInput, ToolResult, UploadInput, ValidationPayload } from "./types.js";

/**
 * Input:
 * - Worker bindings containing possible validation-signing secrets.
 * Output:
 * - The configured signing secret, or null.
 * What this function does:
 * - Selects the secret used to sign and verify upload preflight tokens.
 */
function getSigningSecret(env: EnvBindings): string | null {
  const secret = (env.PREFLIGHT_SIGNING_SECRET || env.ACCESS_CLIENT_SECRET || "").trim();
  return secret || null;
}

/**
 * Input:
 * - Worker bindings and validated file metadata with an expiration time.
 * Output:
 * - A signed validation identifier, or null when no signing secret exists.
 * What this function does:
 * - Creates the short-lived token required by validated Family AI uploads.
 */
export async function createValidationId(env: EnvBindings, payload: ValidationPayload): Promise<string | null> {
  const secret = getSigningSecret(env);
  if (!secret) return null;
  const payloadPart = toBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256Hex(secret, payloadPart);
  return `${payloadPart}.${signature}`;
}

/**
 * Input:
 * - Worker bindings, a validation token, and the uploaded file metadata.
 * Output:
 * - Success or a specific token validation error.
 * What this function does:
 * - Verifies token signature, expiry, and binding to the exact upload.
 */
export async function verifyValidationId(
  env: EnvBindings,
  token: string,
  expected: { filename: string; extension: string; size_bytes: number }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const secret = getSigningSecret(env);
  if (!secret) return { ok: false, error: "Validation signing secret is not configured." };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, error: "validation_id format is invalid." };
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);
  const expectedSignature = await hmacSha256Hex(secret, payloadPart);
  if (signaturePart !== expectedSignature) return { ok: false, error: "validation_id signature check failed." };

  let decoded: Partial<ValidationPayload>;
  try {
    decoded = JSON.parse(fromBase64Url(payloadPart));
  } catch {
    return { ok: false, error: "validation_id payload is invalid." };
  }

  if (!decoded.expires_at || Date.now() > Date.parse(decoded.expires_at)) {
    return { ok: false, error: "validation_id expired. Re-run ingest_validate_file." };
  }
  if (
    decoded.filename !== expected.filename ||
    decoded.extension !== expected.extension ||
    Number(decoded.size_bytes) !== expected.size_bytes
  ) {
    return { ok: false, error: "validation_id does not match file metadata." };
  }

  return { ok: true };
}

/**
 * Input:
 * - A base object key and the file checksum.
 * Output:
 * - An object key containing a short checksum suffix.
 * What this function does:
 * - Avoids collisions between same-named Family AI documents.
 */
function uniqueKey(baseKey: string, checksumHex: string): string {
  const dot = baseKey.lastIndexOf(".");
  const suffix = `__${checksumHex.slice(0, 8)}`;
  if (dot < 0) return `${baseKey}${suffix}`;
  return `${baseKey.slice(0, dot)}${suffix}${baseKey.slice(dot)}`;
}

/**
 * Input:
 * - Upload metadata, file checksum, and extension.
 * Output:
 * - The unique raw key and normalized classification metadata.
 * What this function does:
 * - Builds the hierarchical R2 location used by ingestion artifacts.
 */
function buildRawAndIndexKey(input: Omit<UploadInput, "validation_id" | "file_base64">, checksumHex: string, extension: string) {
  const category = sanitizeCategory(input.category);
  const year = sanitizeYear(input.year);
  const person = sanitizePerson(input.person);
  const filename = toCanonicalFilename(input.filename);
  const docType = (input.doc_type && input.doc_type.trim()) || detectDocType(input.filename, extension);
  const base = `${category}/${year}/${person}/${docType}/${filename}`;
  const rawKey = uniqueKey(base, checksumHex);
  return { rawKey, category, year, person, docType };
}

/**
 * Input:
 * - Worker bindings and source file metadata with optional Base64 bytes.
 * Output:
 * - Preflight support details and a short-lived validation identifier.
 * What this function does:
 * - Checks filename, format, size, and AI Search upload readiness before upload.
 */
export async function validateFile(
  env: EnvBindings,
  input: { filename: string; size_bytes?: number; file_base64?: string }
): Promise<ToolResult> {
  const filename = input.filename.trim();
  if (!filename) return { ok: false, error: "filename is required" };
  if (hasUnsafeFilenameSegments(filename)) return { ok: false, error: "filename contains unsafe path-like segments." };
  const extension = inferExtension(filename);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return { ok: false, filename, extension, error: "File type is not allowed for Family AI upload." };
  }
  const fromPayload = typeof input.file_base64 === "string" && input.file_base64.length > 0;
  const bytes = fromPayload ? decodeBase64ToBytes(String(input.file_base64)) : null;
  const sizeBytes = bytes ? bytes.byteLength : Number(input.size_bytes || 0);
  if (sizeBytes <= 0) return { ok: false, filename, extension, error: "size_bytes must be greater than 0." };
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      filename,
      extension,
      size_bytes: sizeBytes,
      max_upload_size_bytes: MAX_UPLOAD_BYTES,
      error: "File exceeds upload safety limit.",
    };
  }
  const recommended_action = "ai_search_builtin_upload";
  const reason = "File extension is allowed; AI Search built-in storage handles indexing.";

  return {
    ok: true,
    filename,
    extension,
    size_bytes: sizeBytes,
    ai_search_max_file_size_bytes: MAX_UPLOAD_BYTES,
    recommended_action,
    reason,
    validation_id: await createValidationId(env, {
      filename,
      extension,
      size_bytes: sizeBytes,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
    validation_note: "Pass validation_id into ingest_upload_validated_file. It expires in ~10 minutes.",
  };
}

/**
 * Input:
 * - Worker bindings, upload metadata, and already-decoded original bytes.
 * Output:
 * - Stored artifact metadata, AI Search submissions, and warnings.
 * What this function does:
 * - Preserves source bytes and uploads them to AI Search built-in storage.
 */
export async function uploadBytesAndIndex(
  env: EnvBindings,
  input: Omit<UploadInput, "validation_id" | "file_base64">,
  originalBytes: Uint8Array
): Promise<ToolResult> {
  if (!input.filename) return { ok: false, error: "filename is required" };
  if (hasUnsafeFilenameSegments(input.filename)) return { ok: false, error: "filename contains unsafe path-like segments." };

  if (originalBytes.byteLength <= 0) return { ok: false, error: "Decoded file payload is empty." };
  if (originalBytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `File exceeds max upload size (${MAX_UPLOAD_BYTES} bytes).` };
  }
  const extension = inferExtension(input.filename);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return { ok: false, error: "File type is not allowed for Family AI upload." };
  }
  const mimeType = (input.mime_type || "application/octet-stream").trim();
  if (!isMimeCompatible(extension, mimeType)) {
    return { ok: false, error: `mime_type does not match file extension .${extension}` };
  }

  const checksum = toHex(await crypto.subtle.digest("SHA-256", originalBytes.buffer as ArrayBuffer));
  const keys = buildRawAndIndexKey(input, checksum, extension);
  const approvedBy = (input.approved_by?.trim() || "current_user").slice(0, 64);
  const sensitivity = sanitizeSensitivity(input.sensitivity);
  const sourceKind = input.source_kind || "user_provided_file";
  const sourceFilename = (input.source_filename?.trim() || input.filename).slice(0, 255);
  const originalPreserved = input.original_preserved ?? true;
  const storageMetadata: Record<string, string> = {
    category: keys.category,
    year: keys.year,
    person: keys.person,
    doc_type: keys.docType,
    logical_folder: input.logical_folder || "documents",
    source_kind: sourceKind,
    source_filename: sourceFilename,
    original_preserved: String(originalPreserved),
  };
  if (typeof input.extraction_complete === "boolean") {
    storageMetadata.extraction_complete = String(input.extraction_complete);
  }

  await env.R2_RAW.put(keys.rawKey, originalBytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: storageMetadata,
  });

  const aiSearchMetadata = {
    category: keys.category,
    year: keys.year,
    person: keys.person,
    doc_type: keys.docType,
    sensitivity,
  };

  try {
    const uploaded = await uploadItemToAiSearch(env, keys.rawKey, mimeType, originalBytes, aiSearchMetadata);
    return {
      ok: true,
      approved_by: approvedBy,
      sensitivity,
      metadata: {
        category: keys.category,
        year: keys.year,
        person: keys.person,
        doc_type: keys.docType,
        logical_folder: input.logical_folder || "documents",
        source_name: sourceFilename,
        stored_filename: input.filename,
        source_kind: sourceKind,
        original_preserved: originalPreserved,
        extraction_complete: input.extraction_complete,
      },
      raw_key: keys.rawKey,
      index_keys: [{ key: keys.rawKey, bytes: originalBytes.byteLength, mode: "ai_search_builtin" }],
      ai_search_item_uploads: [uploaded],
      warnings: input.extraction_complete === false ? ["Source extraction was marked incomplete by the caller."] : [],
      notes: "Original preserved in R2_RAW and uploaded directly to AI Search built-in storage for managed indexing.",
    };
  } catch (error) {
    return {
      ok: false,
      error: `AI Search item upload failed after preserving original: ${error instanceof Error ? error.message : String(error)}`,
      raw_key: keys.rawKey,
    };
  }
}

export async function uploadAndIndex(env: EnvBindings, input: UploadInput): Promise<ToolResult> {
  if (!input.validation_id || !input.filename || !input.file_base64) {
    return { ok: false, error: "validation_id, filename and file_base64 are required" };
  }
  if (hasUnsafeFilenameSegments(input.filename)) return { ok: false, error: "filename contains unsafe path-like segments." };

  const originalBytes = decodeBase64ToBytes(input.file_base64);
  const extension = inferExtension(input.filename);
  const validation = await verifyValidationId(env, input.validation_id, {
    filename: input.filename,
    extension,
    size_bytes: originalBytes.byteLength,
  });
  if (!validation.ok) return { ok: false, error: validation.error };

  const { validation_id: _validationId, file_base64: _fileBase64, ...uploadInput } = input;
  return uploadBytesAndIndex(env, uploadInput, originalBytes);
}

// The public tool operation uses the shared upload and indexing implementation.
export const uploadValidatedFile = uploadAndIndex;

/**
 * Input:
 * - A fetch response containing ChatGPT-authorized file bytes.
 * Output:
 * - The response body as bytes, or a size error before memory grows unbounded.
 * What this function does:
 * - Streams the temporary file URL with the same upload cap used by normal ingestion.
 */
async function readResponseBytes(response: Response): Promise<Uint8Array | { error: string }> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return { error: `File exceeds max upload size (${MAX_UPLOAD_BYTES} bytes).` };
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      return { error: `File exceeds max upload size (${MAX_UPLOAD_BYTES} bytes).` };
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      return { error: `File exceeds max upload size (${MAX_UPLOAD_BYTES} bytes).` };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Input:
 * - A ChatGPT file-param object plus Family AI metadata.
 * Output:
 * - The standard Family AI upload and indexing result.
 * What this function does:
 * - Fetches ChatGPT's temporary download URL server-side, then reuses byte ingestion.
 */
export async function ingestChatGptFile(env: EnvBindings, input: ChatGptFileInput): Promise<ToolResult> {
  const filename = (input.filename?.trim() || input.file.file_name?.trim() || "chatgpt-upload.bin").slice(0, 255);
  let downloadUrl: URL;
  try {
    downloadUrl = new URL(input.file.download_url);
  } catch {
    return { ok: false, error: "file.download_url must be a valid URL." };
  }
  if (downloadUrl.protocol !== "https:") return { ok: false, error: "file.download_url must use https." };

  const response = await fetch(downloadUrl.toString(), { method: "GET" });
  if (!response.ok) return { ok: false, error: `Could not download ChatGPT file (${response.status}).` };

  const originalBytes = await readResponseBytes(response);
  if (!(originalBytes instanceof Uint8Array)) return { ok: false, error: originalBytes.error };

  return uploadBytesAndIndex(env, {
    filename,
    mime_type: input.file.mime_type || response.headers.get("content-type") || undefined,
    logical_folder: input.logical_folder,
    category: input.category,
    year: input.year,
    person: input.person,
    doc_type: input.doc_type,
    sensitivity: input.sensitivity,
    approved_by: input.approved_by,
    source_kind: "user_provided_file",
    source_filename: input.file.file_name || filename,
    original_preserved: true,
  }, originalBytes);
}

/**
 * Input:
 * - Worker bindings and Markdown generated or extracted in the current chat.
 * Output:
 * - The standard Family AI upload and indexing result.
 * What this function does:
 * - Validates provenance and sends generated Markdown through the same AI Search upload pipeline.
 */
export async function ingestGeneratedText(env: EnvBindings, input: GeneratedTextInput): Promise<ToolResult> {
  const filename = input.filename.trim();
  if (hasUnsafeFilenameSegments(filename)) return { ok: false, error: "filename contains unsafe path-like segments." };
  if (!/\.(md|markdown)$/i.test(filename)) return { ok: false, error: "filename must end in .md or .markdown" };
  if (input.source_filename && hasUnsafeFilenameSegments(input.source_filename)) {
    return { ok: false, error: "source_filename contains unsafe path-like segments." };
  }

  const content = input.content_markdown.trim();
  if (!content) return { ok: false, error: "content_markdown must contain non-whitespace text." };
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `Generated Markdown exceeds max upload size (${MAX_UPLOAD_BYTES} bytes).` };
  }

  const fileBase64 = encodeBytesToBase64(bytes);
  const validation = await validateFile(env, { filename, file_base64: fileBase64 });
  if (!validation.ok) return validation;
  if (typeof validation.validation_id !== "string") {
    return { ok: false, error: "Validation signing secret is not configured." };
  }

  return uploadAndIndex(env, {
    filename,
    validation_id: validation.validation_id,
    file_base64: fileBase64,
    mime_type: "text/markdown",
    logical_folder: input.logical_folder || "chat_sessions",
    category: input.category,
    year: input.year,
    person: input.person,
    doc_type: input.doc_type || "conversation_summary",
    sensitivity: input.sensitivity,
    approved_by: input.approved_by,
    source_kind: "chat_extracted_document",
    source_filename: input.source_filename?.trim(),
    original_preserved: false,
    extraction_complete: input.extraction_complete,
  });
}
