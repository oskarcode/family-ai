// Shared taxonomy values keep MCP inputs compatible with canonical storage paths.
import { CANONICAL_CATEGORY_VALUES, UPLOAD_CATEGORY_VALUES } from "../lib/categories.js";

// Size limits and version identifiers define the deployed ingestion contract.
export const AI_SEARCH_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const SERVER_VERSION = "1.5.1";
export const TOOL_SCHEMA_VERSION = 8;
export const AI_SEARCH_MCP_URL = "https://a32639f0-3330-46c0-8870-623d44234805.search.ai.cloudflare.com/mcp";

// These option lists are the metadata values accepted by Family AI tools.
export const CATEGORY_VALUES = UPLOAD_CATEGORY_VALUES;
export const PERSON_VALUES = ["oskar", "kaitlin", "zadia", "baby2", "shared"] as const;
export const SENSITIVITY_VALUES = ["private", "restricted", "family"] as const;
export const LOGICAL_FOLDER_VALUES = ["chat_sessions", "notes", "summary", "therapy", "journal", "documents"] as const;

// Lookup sets support fast validation and identify formats that are already text.
export const KNOWN_CATEGORIES: Set<string> = new Set(CANONICAL_CATEGORY_VALUES);
export const KNOWN_PEOPLE: Set<string> = new Set(PERSON_VALUES);
export const KNOWN_SENSITIVITY: Set<string> = new Set(SENSITIVITY_VALUES);
export const DIRECT_TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "xml", "yaml", "yml", "html", "htm"]);
export const ALLOWED_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "xml", "yaml", "yml", "html", "htm", "pdf", "doc", "docx", "rtf", "xlsx", "pptx"]);

// MIME hints catch mismatches between declared content types and file extensions.
export const EXTENSION_MIME_HINTS: Record<string, string[]> = {
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain"],
  markdown: ["text/markdown", "text/plain"],
  csv: ["text/csv", "application/csv"],
  json: ["application/json", "text/json"],
  xml: ["application/xml", "text/xml"],
  yaml: ["application/yaml", "text/yaml", "application/x-yaml"],
  yml: ["application/yaml", "text/yaml", "application/x-yaml"],
  html: ["text/html"],
  htm: ["text/html"],
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  rtf: ["application/rtf", "text/rtf"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};
