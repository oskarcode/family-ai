// Shared taxonomy normalization prevents aliases from becoming top-level folders.
import { normalizeCategory } from "../lib/categories.js";

// Ingestion configuration supplies accepted metadata values and MIME hints.
import {
  EXTENSION_MIME_HINTS,
  KNOWN_PEOPLE,
  KNOWN_SENSITIVITY,
} from "./config.js";

/**
 * Input:
 * - An optional category supplied by an ingestion caller.
 * Output:
 * - A known or path-safe custom category, defaulting to "general".
 * What this function does:
 * - Normalizes category metadata for Family AI storage keys.
 */
export function sanitizeCategory(input?: string): string {
  if (!input) return "general";
  return normalizeCategory(input) ?? "general";
}

/**
 * Input:
 * - An optional year value.
 * Output:
 * - A valid 2000s year or "unknown".
 * What this function does:
 * - Normalizes year metadata before it is added to storage paths.
 */
export function sanitizeYear(input?: string): string {
  if (!input) return "unknown";
  const cleaned = input.trim().toLowerCase();
  if (cleaned === "unknown") return "unknown";
  return /^20\d{2}$/.test(cleaned) ? cleaned : "unknown";
}

/**
 * Input:
 * - An optional family person tag.
 * Output:
 * - A known person tag, defaulting to "shared".
 * What this function does:
 * - Restricts ownership metadata to supported Family AI values.
 */
export function sanitizePerson(input?: string): string {
  if (!input) return "shared";
  const cleaned = input.trim().toLowerCase();
  return KNOWN_PEOPLE.has(cleaned) ? cleaned : "shared";
}

/**
 * Input:
 * - An optional sensitivity label.
 * Output:
 * - A known sensitivity value, defaulting to "family".
 * What this function does:
 * - Normalizes the access classification stored with a document.
 */
export function sanitizeSensitivity(input?: string): string {
  if (!input) return "family";
  const cleaned = input.trim().toLowerCase();
  return KNOWN_SENSITIVITY.has(cleaned) ? cleaned : "family";
}

/**
 * Input:
 * - A filename.
 * Output:
 * - Its lowercase extension or "(no_ext)".
 * What this function does:
 * - Derives the format used by validation and MIME checks.
 */
export function inferExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "(no_ext)";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Input:
 * - A user-provided filename.
 * Output:
 * - True when the name contains path traversal or is empty.
 * What this function does:
 * - Prevents filenames from escaping Family AI storage-key boundaries.
 */
export function hasUnsafeFilenameSegments(filename: string): boolean {
  return filename.includes("/") || filename.includes("\\") || filename.includes("..") || filename.trim().length === 0;
}

/**
 * Input:
 * - A file extension and optional declared MIME type.
 * Output:
 * - True when the MIME type is absent, unknown, or compatible.
 * What this function does:
 * - Rejects known extension and content-type mismatches before ingestion.
 */
export function isMimeCompatible(extension: string, mimeType?: string): boolean {
  if (!mimeType) return true;
  const normalized = mimeType.toLowerCase().trim();
  if (!normalized) return true;
  const allowed = EXTENSION_MIME_HINTS[extension];
  if (!allowed) return true;
  return allowed.some((mime) => normalized.startsWith(mime));
}

/**
 * Input:
 * - A plain string.
 * Output:
 * - Its unpadded URL-safe Base64 representation.
 * What this function does:
 * - Encodes signed validation payloads for safe token transport.
 */
export function toBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Input:
 * - An unpadded URL-safe Base64 string.
 * Output:
 * - The decoded plain string.
 * What this function does:
 * - Restores a validation payload before signature and metadata checks.
 */
export function fromBase64Url(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  return atob(base64 + padding);
}

/**
 * Input:
 * - A signing secret and message.
 * Output:
 * - The HMAC-SHA256 signature as lowercase hexadecimal text.
 * What this function does:
 * - Signs Family AI preflight tokens with the configured secret.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(signature as ArrayBuffer);
}

/**
 * Input:
 * - Raw Base64 text or a Base64 data URL.
 * Output:
 * - Base64 content without a data URL prefix.
 * What this function does:
 * - Normalizes caller-provided file payloads before decoding.
 */
export function stripDataUrlPrefix(rawBase64: string): string {
  const index = rawBase64.indexOf(",");
  if (rawBase64.startsWith("data:") && index > -1) return rawBase64.slice(index + 1);
  return rawBase64;
}

/**
 * Input:
 * - Raw Base64 text or a Base64 data URL.
 * Output:
 * - The decoded file bytes.
 * What this function does:
 * - Converts MCP upload payloads into bytes for validation and storage.
 */
export function decodeBase64ToBytes(rawBase64: string): Uint8Array {
  const cleaned = stripDataUrlPrefix(rawBase64).replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Uint8Array(bytes.buffer.slice(0));
}

/**
 * Input:
 * - Binary file bytes.
 * Output:
 * - A standard Base64 string.
 * What this function does:
 * - Encodes generated Markdown for the shared file-ingestion pipeline.
 */
export function encodeBytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

/**
 * Input:
 * - Raw binary data.
 * Output:
 * - The same bytes represented as lowercase hexadecimal text.
 * What this function does:
 * - Formats checksums and signatures for stable storage and comparison.
 */
export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
