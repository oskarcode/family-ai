// MCP SDK and Zod provide tool registration and runtime schemas.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Family AI modules supply tool operations, shared option values, and Worker bindings.
import { checkStatus } from "./cloudflare-api.js";
import {
  CATEGORY_VALUES,
  LOGICAL_FOLDER_VALUES,
  PERSON_VALUES,
  SENSITIVITY_VALUES,
  SERVER_VERSION,
  TOOL_SCHEMA_VERSION,
} from "./config.js";
import { deleteFamilyDocument } from "./deletion.js";
import { ingestChatGptFile, ingestGeneratedText, uploadValidatedFile, validateFile } from "./ingestion.js";
import { searchFamilyDocuments } from "./search.js";
import type { EnvBindings } from "./types.js";

/**
 * Input:
 * - A structured Family AI tool result payload.
 * Output:
 * - The MCP text and structured-content response shape.
 * What this function does:
 * - Serializes one result consistently for MCP clients.
 */
function toToolResponse(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Input:
 * - Family AI Worker bindings used by ingestion and status tools.
 * Output:
 * - A configured MCP server containing all Family AI tools.
 * What this function does:
 * - Registers search, ingestion, status, and capability tools on one server.
 */
export function createUnifiedServer(env: EnvBindings) {
  const server = new McpServer({ name: "family-ai-mcp", version: SERVER_VERSION });
  const openAiFileSchema = z.object({
    download_url: z.string().url(),
    file_id: z.string().min(1),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  }).strict();

  // Capability discovery reports the server contract and supported tool names.
  server.registerTool(
    "family_ai_server_info",
    {
      description: "Return the unified Family AI search and ingestion server capabilities and schema version.",
      inputSchema: {},
      outputSchema: {
        ok: z.literal(true),
        service: z.literal("family-ai-mcp"),
        server_version: z.string(),
        tool_schema_version: z.number().int(),
        tools: z.array(z.string()),
        required_upload_fields: z.array(z.string()),
        optional_upload_fields: z.array(z.string()),
        generated_text_fields: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toToolResponse({
      ok: true,
      service: "family-ai-mcp",
      server_version: SERVER_VERSION,
      tool_schema_version: TOOL_SCHEMA_VERSION,
      tools: ["family_ai_server_info", "search", "delete_file", "ingest_validate_file", "ingest_upload_validated_file", "ingest_chatgpt_file", "ingest_generated_text", "ingest_status"],
      required_upload_fields: ["validation_id", "filename", "file_base64"],
      optional_upload_fields: ["mime_type", "logical_folder", "category", "year", "person", "doc_type", "sensitivity", "approved_by", "index_markdown_fallback"],
      generated_text_fields: ["filename", "content_markdown", "extraction_complete", "source_filename"],
    })
  );

  // ChatGPT file-param ingestion receives a temporary authorized file URL from ChatGPT.
  server.registerTool(
    "ingest_chatgpt_file",
    {
      description: "Ingest a ChatGPT-attached file using OpenAI Apps SDK file params. Use this when ChatGPT can pass a file object with download_url and file_id. The Worker downloads the temporary file URL server-side, preserves original bytes in private R2, derives index artifacts, and updates AI Search. Generic MCP clients should use ingest_upload_validated_file for Base64 bytes.",
      inputSchema: {
        file: openAiFileSchema,
        filename: z.string().trim().min(1).max(255).optional(),
        logical_folder: z.enum(LOGICAL_FOLDER_VALUES).optional(),
        category: z.enum(CATEGORY_VALUES).optional(),
        year: z.union([z.literal("unknown"), z.string().regex(/^20\d{2}$/)]).optional(),
        person: z.enum(PERSON_VALUES).optional(),
        doc_type: z.string().trim().regex(/^[a-z0-9_-]{2,64}$/).optional(),
        sensitivity: z.enum(SENSITIVITY_VALUES).optional(),
        approved_by: z.string().trim().regex(/^[a-z0-9_-]{2,64}$/).optional(),
        index_markdown_fallback: z.string().trim().min(1).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        error: z.string().optional(),
        approved_by: z.string().optional(),
        sensitivity: z.string().optional(),
        metadata: z.object({
          category: z.string(),
          year: z.string(),
          person: z.string(),
          doc_type: z.string(),
          logical_folder: z.string(),
          source_name: z.string(),
          stored_filename: z.string(),
          source_kind: z.literal("user_provided_file"),
          original_preserved: z.literal(true),
          extraction_complete: z.boolean().optional(),
        }).optional(),
        raw_key: z.string().optional(),
        index_keys: z.array(z.object({ key: z.string(), bytes: z.number(), mode: z.string() })).optional(),
        ai_search_item_uploads: z.array(z.object({ id: z.string(), key: z.string(), status: z.string() }).passthrough()).optional(),
        sync_job: z.record(z.string(), z.unknown()).nullable().optional(),
        warnings: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["file"] },
    },
    async (args) => {
      const result = await ingestChatGptFile(env, args);
      return toToolResponse(result);
    }
  );

  server.registerTool(
    "delete_file",
    {
      description: "Delete a duplicated or incorrect Family AI file from private R2 storage and, when possible, delete matching AI Search items. Requires an exact canonical key by default; prefix deletion is supported only with an explicit match='prefix' and confirm_delete=true.",
      inputSchema: {
        key_or_prefix: z.string()
          .trim()
          .min(1)
          .max(512)
          .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), {
            message: "key_or_prefix must be a canonical relative object key or prefix.",
          })
          .describe("Exact canonical object key from a search result or upload response, for example medical/2026/kaitlin/birth_plan/file.md. For prefix deletes, use a narrow folder/file prefix."),
        match: z.enum(["exact", "prefix"]).optional().describe("Use exact unless intentionally removing every object under a narrow duplicate prefix."),
        buckets: z.enum(["index_ready", "raw", "both"]).optional().describe("Which private R2 bucket artifacts to delete. Defaults to both."),
        delete_ai_search_items: z.boolean().optional().describe("Also remove AI Search items whose key matches deleted index-ready objects. Defaults to true."),
        confirm_delete: z.boolean().optional().describe("Required true acknowledgement that this permanently removes private family records from storage/search."),
      },
      outputSchema: {
        ok: z.boolean(),
        error: z.string().optional(),
        deleted_objects: z.array(z.object({ bucket: z.string(), key: z.string() })).optional(),
        deleted_object_count: z.number().optional(),
        missing_objects: z.array(z.object({ bucket: z.string(), key: z.string() })).optional(),
        deleted_ai_search_items: z.array(z.object({ id: z.string(), key: z.string().optional() })).optional(),
        deleted_ai_search_item_count: z.number().optional(),
        ai_search_errors: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = await deleteFamilyDocument(env, args);
      return toToolResponse(result);
    }
  );

  // Search forwards private family-document queries to the AI Search MCP endpoint.
  server.registerTool(
    "search",
    {
      description: "Search private Family AI documents and return evidence with source keys, text, scores, and metadata. For ordinary questions, use ai_search_options. When the user names an indexed item path or folder, pass one or more exact canonical key prefixes in source_prefixes; this strictly returns only matching source objects and is the reliable way to retrieve complete known chat histories.",
      inputSchema: {
        query: z.string().min(1).describe("The family-document question or search phrase."),
        source_prefixes: z.array(
          z.string()
            .trim()
            .min(1)
            .max(512)
            .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), {
              message: "Source prefixes must be canonical relative object-key prefixes.",
            })
        ).min(1).max(10).optional().describe(
          "Strict canonical object-key prefixes, for example relationship/2026/oskar/relationship_chat. Use when a known indexed path or source must be retrieved without unrelated semantic matches."
        ),
        ai_search_options: z.object({
          retrieval: z.object({
            retrieval_type: z.enum(["vector", "keyword", "hybrid"]).optional(),
            fusion_method: z.enum(["max", "rrf"]).optional(),
            match_threshold: z.number().min(0).max(1).optional(),
            max_num_results: z.number().int().min(1).max(50).optional(),
            filters: z.record(z.string(), z.unknown()).optional(),
            context_expansion: z.number().int().min(0).max(3).optional(),
            metadata_only: z.boolean().optional(),
            return_on_failure: z.boolean().optional(),
          }).optional(),
          query_rewrite: z.object({
            enabled: z.boolean().optional(),
            model: z.string().optional(),
            rewrite_prompt: z.string().optional(),
          }).optional(),
          reranking: z.object({
            enabled: z.boolean().optional(),
            model: z.string().optional(),
            match_threshold: z.number().min(0).max(1).optional(),
          }).optional(),
          cache: z.object({
            enabled: z.boolean().optional(),
            cache_threshold: z.string().optional(),
          }).optional(),
        }).optional(),
      },
      outputSchema: {
        success: z.boolean(),
        error: z.string().optional(),
        result: z.object({
          query_kind: z.string(),
          search_query: z.string(),
          chunks: z.array(z.object({
            id: z.string(),
            type: z.string(),
            score: z.number(),
            text: z.string(),
            item: z.object({
              key: z.string(),
              timestamp: z.number().optional(),
              metadata: z.record(z.string(), z.unknown()).optional(),
            }).passthrough(),
            scoring_details: z.record(z.string(), z.unknown()).optional(),
          }).passthrough()),
          hybrid_meta: z.object({
            search_methods: z.array(z.string()).optional(),
            vector_result_count: z.number().optional(),
            keyword_result_count: z.number().optional(),
          }).passthrough().optional(),
        }).passthrough().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, source_prefixes, ai_search_options }) => {
      const result = await searchFamilyDocuments(env, { query, source_prefixes, ai_search_options });
      return toToolResponse(result);
    }
  );

  // File validation performs the preflight required before uploading user bytes.
  server.registerTool(
    "ingest_validate_file",
    {
      description: "Step 1 (preflight). Validate a user-provided family document for ingestion into the configured family knowledge base. Enforces extension/size checks and returns a short-lived validation_id required by ingest_upload_validated_file. Cloudflare Access authentication is enforced when its credentials are configured.",
      inputSchema: {
        filename: z.string().min(1),
        mime_type: z.string().optional(),
        size_bytes: z.number().optional(),
        file_base64: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        filename: z.string().optional(),
        extension: z.string().optional(),
        size_bytes: z.number().optional(),
        max_upload_size_bytes: z.number().optional(),
        ai_search_max_file_size_bytes: z.number().optional(),
        direct_supported: z.boolean().optional(),
        can_convert: z.boolean().optional(),
        recommended_action: z.enum(["direct_upload", "convert_then_split", "reject"]).optional(),
        reason: z.string().optional(),
        validation_id: z.string().nullable().optional(),
        validation_note: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ filename, size_bytes, file_base64 }) => {
      const result = await validateFile(env, { filename, size_bytes, file_base64 });
      return toToolResponse(result);
    }
  );

  // Validated upload persists original and index-ready family document artifacts.
  server.registerTool(
    "ingest_upload_validated_file",
    {
      description: "Step 2 (execute upload). Ingest a prevalidated family document into the configured family workspace. Requires validation_id from ingest_validate_file plus original file_base64 bytes, writes to private R2 storage, derives index artifacts, and updates AI Search. This is the MCP-native preserved-original upload path when a client can provide bytes but cannot perform external HTTP PUT. Does not fetch external URLs or system files.",
      inputSchema: {
        validation_id: z.string().min(20),
        filename: z.string().min(1),
        file_base64: z.string().min(1),
        mime_type: z.string().optional(),
        logical_folder: z.enum(LOGICAL_FOLDER_VALUES).optional(),
        category: z.enum(CATEGORY_VALUES).optional(),
        year: z.union([z.literal("unknown"), z.string().regex(/^20\d{2}$/)]).optional(),
        person: z.enum(PERSON_VALUES).optional(),
        doc_type: z.string().trim().regex(/^[a-z0-9_-]{2,64}$/).optional(),
        sensitivity: z.enum(SENSITIVITY_VALUES).optional(),
        approved_by: z.string().trim().regex(/^[a-z0-9_-]{2,64}$/).optional(),
        index_markdown_fallback: z.string().trim().min(1).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        error: z.string().optional(),
        approved_by: z.string().optional(),
        sensitivity: z.string().optional(),
        metadata: z.object({
          category: z.string(),
          year: z.string(),
          person: z.string(),
          doc_type: z.string(),
          logical_folder: z.string(),
          source_name: z.string(),
          stored_filename: z.string(),
          source_kind: z.enum(["user_provided_file", "chat_extracted_document"]),
          original_preserved: z.boolean(),
          extraction_complete: z.boolean().optional(),
        }).optional(),
        raw_key: z.string().optional(),
        index_keys: z.array(z.object({ key: z.string(), bytes: z.number(), mode: z.string() })).optional(),
        ai_search_item_uploads: z.array(z.object({ id: z.string(), key: z.string(), status: z.string() }).passthrough()).optional(),
        sync_job: z.record(z.string(), z.unknown()).nullable().optional(),
        warnings: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const result = await uploadValidatedFile(env, args);
      return toToolResponse(result);
    }
  );

  // Generated-text ingestion stores chat-derived Markdown with provenance metadata.
  server.registerTool(
    "ingest_generated_text",
    {
      description: "Ingest Markdown generated from the current chat or extracted from a source document when original file bytes are unavailable. Records that the searchable document is derived text, whether extraction was complete, and that the original source was not preserved. Uses the same private R2 and AI Search pipeline as validated file uploads.",
      inputSchema: {
        filename: z.string().trim().min(4).max(255),
        content_markdown: z.string().min(1),
        extraction_complete: z.boolean(),
        source_filename: z.string().trim().min(1).max(255).optional(),
        logical_folder: z.enum(LOGICAL_FOLDER_VALUES).optional(),
        category: z.enum(CATEGORY_VALUES).optional(),
        year: z.union([z.literal("unknown"), z.string().regex(/^20\d{2}$/)]).optional(),
        person: z.enum(PERSON_VALUES).optional(),
        doc_type: z.string().trim().regex(/^[a-z0-9_-]{2,64}$/).optional(),
        sensitivity: z.enum(SENSITIVITY_VALUES).optional(),
        approved_by: z.string().trim().regex(/^[a-z0-9_-]{2,64}$/).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        error: z.string().optional(),
        approved_by: z.string().optional(),
        sensitivity: z.string().optional(),
        metadata: z.object({
          category: z.string(),
          year: z.string(),
          person: z.string(),
          doc_type: z.string(),
          logical_folder: z.string(),
          source_name: z.string(),
          stored_filename: z.string(),
          source_kind: z.literal("chat_extracted_document"),
          original_preserved: z.literal(false),
          extraction_complete: z.boolean(),
        }).optional(),
        raw_key: z.string().optional(),
        index_keys: z.array(z.object({ key: z.string(), bytes: z.number(), mode: z.string() })).optional(),
        ai_search_item_uploads: z.array(z.object({ id: z.string(), key: z.string(), status: z.string() }).passthrough()).optional(),
        sync_job: z.record(z.string(), z.unknown()).nullable().optional(),
        warnings: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const result = await ingestGeneratedText(env, args);
      return toToolResponse(result);
    }
  );

  // Ingestion status polls AI Search for previously submitted item identifiers.
  server.registerTool(
    "ingest_status",
    {
      description: "Post-ingestion check. Poll AI Search indexing status for one or more item IDs returned by ingest_upload_validated_file or ingest_generated_text. Use to confirm queued/running/completed and detect item-level errors.",
      inputSchema: {
        item_ids: z.array(z.string().min(1)).min(1),
      },
      outputSchema: {
        ok: z.boolean(),
        error: z.string().optional(),
        item_statuses: z.array(z.record(z.string(), z.unknown())).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ item_ids }) => {
      const result = await checkStatus(env, { item_ids });
      return toToolResponse(result);
    }
  );

  return server;
}
