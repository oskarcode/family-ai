// Extend Wrangler-generated bindings only with secrets that are injected at deploy time.
export type EnvBindings = IngestEnv & {
  AI_SEARCH?: AiSearchInstance;
  CF_API_TOKEN?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  PREFLIGHT_SIGNING_SECRET?: string;
};

// ToolResult is the common extensible result envelope returned by MCP operations.
export type ToolResult = {
  ok: boolean;
  [key: string]: unknown;
};

// UploadInput contains validated file bytes, metadata, and provenance controls.
export type UploadInput = {
  validation_id: string;
  filename: string;
  file_base64: string;
  mime_type?: string;
  logical_folder?: string;
  category?: string;
  year?: string;
  person?: string;
  doc_type?: string;
  sensitivity?: string;
  approved_by?: string;
  source_kind?: "user_provided_file" | "chat_extracted_document";
  source_filename?: string;
  original_preserved?: boolean;
  extraction_complete?: boolean;
  index_markdown_fallback?: string;
};

// OpenAIFileInput is the ChatGPT Apps SDK file-param shape passed to tools.
export type OpenAIFileInput = {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
};

// ChatGptFileInput adapts a ChatGPT-authorized file reference into Family AI ingestion.
export type ChatGptFileInput = Omit<
  UploadInput,
  "validation_id" | "filename" | "file_base64" | "mime_type" | "source_kind" | "source_filename" | "original_preserved" | "extraction_complete"
> & {
  file: OpenAIFileInput;
  filename?: string;
};

// GeneratedTextInput replaces uploaded bytes with chat-derived Markdown content.
export type GeneratedTextInput = Omit<
  UploadInput,
  "validation_id" | "file_base64" | "mime_type" | "source_kind" | "original_preserved" | "index_markdown_fallback"
> & {
  content_markdown: string;
  extraction_complete: boolean;
};

// SearchInput mirrors the query and optional controls accepted by AI Search.
export type SearchInput = {
  query: string;
  source_prefixes?: string[];
  ai_search_options?: Record<string, unknown>;
};

// ValidationPayload is the signed preflight claim bound to one file upload.
export type ValidationPayload = {
  filename: string;
  extension: string;
  size_bytes: number;
  expires_at: string;
};
