// Vitest supplies the test lifecycle, assertions, and isolated mocks.
import { afterEach, describe, expect, it, vi } from "vitest";

// MCP client and in-memory transport exercise the registered tools without network transport.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The Agents SDK HTTP adapter is outside these manifest-level unit tests.
vi.mock("agents/mcp", () => ({
  createMcpHandler: vi.fn(),
}));

// Import after mock registration so server construction uses the isolated transport dependency.
import { createUnifiedServer } from "./index.js";

// Minimal test bindings identify the service while individual tests inject storage and signing fakes.
const env = {
  APP_ENV: "test",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  AI_SEARCH_INSTANCE_ID: "test-instance",
  AI_SEARCH_NAMESPACE: "default",
};

/**
 * Input:
 * - Optional Worker binding overrides for the test scenario.
 * Output:
 * - A connected in-memory MCP client.
 * What this function does:
 * - Creates the unified server and links it to a client without opening a network connection.
 */
async function createClient(envOverrides: Record<string, unknown> = {}) {
  const server = createUnifiedServer({ ...env, ...envOverrides } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "manifest-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("unified Family AI MCP manifest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes search and ingestion tools with output schemas", /**
   * Input:
   * - The unified server running over an in-memory MCP transport.
   * Output:
   * - Assertions that every expected tool and key input constraint is published.
   * What this function does:
   * - Verifies the public tool manifest remains complete and machine-readable.
   */
  async () => {
    const client = await createClient();
    const result = await client.listTools();
    const tools = result.tools as Array<{
      name: string;
      inputSchema: { properties?: Record<string, { enum?: string[] }>; required?: string[] };
      outputSchema?: object;
      _meta?: Record<string, unknown>;
    }>;

    expect(tools.map((tool) => tool.name)).toEqual([
      "family_ai_server_info",
      "ingest_chatgpt_file",
      "delete_file",
      "search",
      "ingest_validate_file",
      "ingest_upload_validated_file",
      "ingest_generated_text",
      "ingest_status",
    ]);
    expect(tools.every((tool) => tool.outputSchema)).toBe(true);

    const upload = tools.find((tool) => tool.name === "ingest_upload_validated_file");
    expect(upload?.inputSchema.required).toEqual(["validation_id", "filename", "file_base64"]);
    expect(upload?.inputSchema.properties?.logical_folder?.enum).toEqual([
      "chat_sessions",
      "notes",
      "summary",
      "therapy",
      "journal",
      "documents",
    ]);
    expect(upload?.inputSchema.properties?.category?.enum).toContain("relationship");
    expect(upload?.inputSchema.properties?.category?.enum).toContain("finance");
    expect(upload?.inputSchema.properties?.category?.enum).not.toContain("family");

    const generated = tools.find((tool) => tool.name === "ingest_generated_text");
    expect(generated?.inputSchema.required).toEqual(["filename", "content_markdown", "extraction_complete"]);
    const chatGptFile = tools.find((tool) => tool.name === "ingest_chatgpt_file");
    expect(chatGptFile?.inputSchema.required).toEqual(["file"]);
    expect(chatGptFile?._meta?.["openai/fileParams"]).toEqual(["file"]);
    const search = tools.find((tool) => tool.name === "search");
    expect(search?.inputSchema.properties).toHaveProperty("source_prefixes");
  });

  it("returns machine-readable unified server information", /**
   * Input:
   * - A call to the server-information tool with no arguments.
   * Output:
   * - Assertions for the advertised versions and upload fields.
   * What this function does:
   * - Confirms clients can discover the unified server contract through structured content.
   */
  async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "family_ai_server_info",
      arguments: {},
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      service: "family-ai-mcp",
      server_version: "1.5.1",
      tool_schema_version: 8,
      tools: [
        "family_ai_server_info",
        "search",
        "delete_file",
        "ingest_validate_file",
        "ingest_upload_validated_file",
        "ingest_chatgpt_file",
        "ingest_generated_text",
        "ingest_status",
      ],
      required_upload_fields: ["validation_id", "filename", "file_base64"],
    });
    expect((result.structuredContent as Record<string, unknown>).optional_upload_fields).toContain("logical_folder");
    expect((result.structuredContent as Record<string, unknown>).optional_upload_fields).toContain("index_markdown_fallback");
    expect((result.structuredContent as Record<string, unknown>).generated_text_fields).toContain("content_markdown");
  });

  it("ingests a ChatGPT file-param download through the shared byte pipeline", /**
   * Input:
   * - A ChatGPT file object with a temporary download URL and mocked private R2 bindings.
   * Output:
   * - Assertions that the file bytes are downloaded, preserved, and indexed.
   * What this function does:
   * - Exercises the ChatGPT-specific adapter without duplicating upload logic.
   */
  async () => {
    const rawPut = vi.fn(async (_key: string, _value: unknown, _options?: unknown) => undefined);
    const indexPut = vi.fn(async (_key: string, _value: unknown, _options?: unknown) => undefined);
    const fetchMock = vi.fn(async () => new Response("chatgpt original bytes", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": "22",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await createClient({
      R2_RAW: { put: rawPut },
      R2_INDEX_READY: { put: indexPut },
    });

    const result = await client.callTool({
      name: "ingest_chatgpt_file",
      arguments: {
        file: {
          download_url: "https://files.example/download/test-file",
          file_id: "file_test123",
          mime_type: "text/plain",
          file_name: "chatgpt-note.txt",
        },
        category: "general",
        year: "2026",
        person: "shared",
        doc_type: "chatgpt_note",
        approved_by: "oskar",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://files.example/download/test-file", { method: "GET" });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      metadata: {
        category: "general",
        year: "2026",
        person: "shared",
        doc_type: "chatgpt_note",
        source_name: "chatgpt-note.txt",
        stored_filename: "chatgpt-note.txt",
        source_kind: "user_provided_file",
        original_preserved: true,
      },
    });
    expect(rawPut).toHaveBeenCalledOnce();
    expect(indexPut).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(rawPut.mock.calls[0]?.[1] as Uint8Array)).toBe("chatgpt original bytes");
  });

  it("rejects oversized ChatGPT file downloads before storing bytes", async () => {
    const rawPut = vi.fn(async (_key: string, _value: unknown, _options?: unknown) => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("too large", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": String(10 * 1024 * 1024 + 1),
      },
    })));
    const client = await createClient({ R2_RAW: { put: rawPut } });

    const result = await client.callTool({
      name: "ingest_chatgpt_file",
      arguments: {
        file: {
          download_url: "https://files.example/download/large-file",
          file_id: "file_large",
          mime_type: "text/plain",
          file_name: "large-note.txt",
        },
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: "File exceeds max upload size (10485760 bytes).",
    });
    expect(rawPut).not.toHaveBeenCalled();
  });

  it("indexes caller-provided Markdown when PDF conversion fails", /**
   * Input:
   * - A validated PDF upload with extracted Markdown fallback and no conversion API token.
   * Output:
   * - Assertions that the original PDF is preserved and Markdown fallback is indexed.
   * What this function does:
   * - Prevents PDF conversion failures from forcing summary-only ingestion in clients that already extracted text.
   */
  async () => {
    const rawPut = vi.fn(async (_key: string, _value: unknown, _options?: unknown) => undefined);
    const indexPut = vi.fn(async (_key: string, _value: unknown, _options?: unknown) => undefined);
    const client = await createClient({
      PREFLIGHT_SIGNING_SECRET: "test-signing-secret",
      R2_RAW: { put: rawPut },
      R2_INDEX_READY: { put: indexPut },
    });
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 fake pdf bytes");
    const fileBase64 = btoa(String.fromCharCode(...pdfBytes));

    const validation = await client.callTool({
      name: "ingest_validate_file",
      arguments: {
        filename: "doula-services-agreement.pdf",
        file_base64: fileBase64,
      },
    });
    const validationId = (validation.structuredContent as Record<string, unknown>).validation_id;

    const result = await client.callTool({
      name: "ingest_upload_validated_file",
      arguments: {
        validation_id: validationId,
        filename: "doula-services-agreement.pdf",
        file_base64: fileBase64,
        mime_type: "application/pdf",
        category: "medical",
        year: "2026",
        person: "kaitlin",
        doc_type: "doula_services_agreement",
        approved_by: "oskar",
        index_markdown_fallback: "# Doula Services Agreement\n\nExtracted agreement details.",
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      metadata: {
        category: "medical",
        year: "2026",
        person: "kaitlin",
        doc_type: "doula_services_agreement",
        source_kind: "user_provided_file",
        original_preserved: true,
      },
      index_keys: [
        expect.objectContaining({ mode: "fallback_markdown" }),
      ],
    });
    expect(rawPut).toHaveBeenCalledOnce();
    expect(indexPut).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(indexPut.mock.calls[0]?.[1] as Uint8Array)).toContain("Doula Services Agreement");
    expect((result.structuredContent as { warnings?: string[] }).warnings?.[0]).toContain("Original file conversion failed");
  });

  it("stores generated Markdown with explicit derived-document provenance", /**
   * Input:
   * - Generated Markdown, source metadata, and mocked private R2 bindings.
   * Output:
   * - Assertions for stored artifacts and derived-document provenance metadata.
   * What this function does:
   * - Confirms generated text uses the ingestion pipeline without claiming original bytes were preserved.
   */
  async () => {
    const rawPut = vi.fn(async (_key: string, _value: unknown, _options?: unknown) => undefined);
    const indexPut = vi.fn(async (_key: string, _value: unknown, _options?: unknown) => undefined);
    const client = await createClient({
      PREFLIGHT_SIGNING_SECRET: "test-signing-secret",
      R2_RAW: { put: rawPut },
      R2_INDEX_READY: { put: indexPut },
    });

    const result = await client.callTool({
      name: "ingest_generated_text",
      arguments: {
        filename: "insurance-chat-summary.md",
        content_markdown: "# Insurance summary\n\nExtracted policy details.",
        extraction_complete: true,
        source_filename: "insurance-policy.pdf",
        category: "health",
        year: "2026",
        person: "shared",
        approved_by: "oskar",
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      metadata: {
        category: "medical",
        source_name: "insurance-policy.pdf",
        stored_filename: "insurance-chat-summary.md",
        source_kind: "chat_extracted_document",
        original_preserved: false,
        extraction_complete: true,
        logical_folder: "chat_sessions",
        doc_type: "conversation_summary",
      },
    });
    expect(rawPut).toHaveBeenCalledOnce();
    expect(indexPut).toHaveBeenCalledOnce();
    expect(rawPut.mock.calls[0]?.[0]).toMatch(/^medical\//);
    expect(indexPut.mock.calls[0]?.[0]).toMatch(/^medical\//);
    expect(rawPut.mock.calls[0]?.[2]).toMatchObject({
      customMetadata: {
        source_kind: "chat_extracted_document",
        source_filename: "insurance-policy.pdf",
        original_preserved: "false",
        extraction_complete: "true",
      },
    });
  });

  it("converts managed search text into structured content", /**
   * Input:
   * - A managed AI Search MCP server-sent event response.
   * Output:
   * - Assertions for the parsed structured search result.
   * What this function does:
   * - Verifies the search adapter extracts JSON-RPC text content from the event stream.
   */
  async () => {
    vi.stubGlobal("fetch", vi.fn(/**
     * Input:
     * - The application-specific managed AI Search request, ignored by this deterministic mock.
     * Output:
     * - A successful server-sent event carrying one structured search result.
     * What this function does:
     * - Reproduces the managed MCP response shape consumed by the search adapter.
     */
    async () => new Response(
      `event: message\ndata: ${JSON.stringify({
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              query_kind: "text",
              search_query: "mortgage",
              chunks: [{
                id: "chunk-1",
                type: "text",
                score: 0.91,
                text: "Mortgage evidence",
                item: { key: "finance/2026/shared/mortgage.md" },
              }],
            }),
          }],
        },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )));

    const client = await createClient();
    const result = await client.callTool({ name: "search", arguments: { query: "mortgage" } });

    expect(result.structuredContent).toMatchObject({
      success: true,
      result: {
        search_query: "mortgage",
        chunks: [{ score: 0.91, item: { key: "finance/2026/shared/mortgage.md" } }],
      },
    });
  });

  it("enforces category-filtered search results after AI Search returns mixed chunks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `event: message\ndata: ${JSON.stringify({
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              result: {
                query_kind: "text",
                search_query: "tax return",
                chunks: [
                  {
                    id: "chunk-1",
                    type: "text",
                    score: 0.91,
                    text: "General smoke test",
                    item: { key: "general/2026/shared/smoke.txt", metadata: { category: "general" } },
                  },
                  {
                    id: "chunk-2",
                    type: "text",
                    score: 0.82,
                    text: "Tax package evidence",
                    item: { key: "financial/2024/oskar/tax-return.pdf", metadata: { category: "financial" } },
                  },
                  {
                    id: "chunk-3",
                    type: "text",
                    score: 0.79,
                    text: "Mortgage evidence without metadata",
                    item: { key: "financial/2026/shared/mortgage.pdf" },
                  },
                ],
              },
            }),
          }],
        },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )));

    const client = await createClient();
    const result = await client.callTool({
      name: "search",
      arguments: {
        query: "tax return",
        ai_search_options: {
          retrieval: { filters: { category: "financial" } },
        },
      },
    });

    expect(result.structuredContent).toMatchObject({
      success: true,
      result: {
        chunks: [
          { id: "chunk-2", scoring_details: { family_ai_category_filter: "financial" } },
          { id: "chunk-3", scoring_details: { family_ai_category_filter: "financial" } },
        ],
        family_ai_category_filter_meta: {
          category: "financial",
          original_chunk_count: 3,
          returned_chunk_count: 2,
        },
      },
    });
  });

  it("keeps category-filtered search results unchanged when no chunks match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `event: message\ndata: ${JSON.stringify({
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              result: {
                query_kind: "text",
                search_query: "tax return",
                chunks: [{
                  id: "chunk-1",
                  type: "text",
                  score: 0.91,
                  text: "Tax package evidence",
                  item: { key: "financial/2024/oskar/tax-return.pdf", metadata: { category: "financial" } },
                }],
              },
            }),
          }],
        },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )));

    const client = await createClient();
    const result = await client.callTool({
      name: "search",
      arguments: {
        query: "tax return",
        ai_search_options: {
          retrieval: { filters: { category: "medical" } },
        },
      },
    });

    expect(result.structuredContent).toMatchObject({
      success: true,
      result: { chunks: [{ id: "chunk-1" }] },
    });
    expect((result.structuredContent as Record<string, { family_ai_category_filter_meta?: unknown }>).result.family_ai_category_filter_meta).toBeUndefined();
  });

  it("retrieves only exact source prefixes from private index storage", async () => {
    const objects = new Map([
      [
        "relationship/2026/oskar/relationship_chat/oskar-session.md",
        "Oskar first-person relationship history.",
      ],
      [
        "relationship/2026/kaitlin/relationship_chat/kaitlin-session.md",
        "Kaitlin first-person relationship history.",
      ],
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await createClient({
      R2_INDEX_READY: {
        list: vi.fn(async ({ prefix }: { prefix: string }) => ({
          objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
          truncated: false,
        })),
        get: vi.fn(async (key: string) => {
          const text = objects.get(key);
          if (!text) return null;
          return {
            httpMetadata: { contentType: "text/markdown" },
            customMetadata: { category: "relationship" },
            uploaded: new Date("2026-08-14T12:00:00Z"),
            text: async () => text,
          };
        }),
      },
    });

    const result = await client.callTool({
      name: "search",
      arguments: {
        query: "Compare both relationship perspectives",
        source_prefixes: [
          "relationship/2026/oskar/relationship_chat",
          "relationship/2026/kaitlin/relationship_chat",
        ],
        ai_search_options: { retrieval: { max_num_results: 20 } },
      },
    });

    expect(result.structuredContent).toMatchObject({
      success: true,
      result: {
        query_kind: "source_prefix",
        source_prefix_meta: { matched_object_count: 2, returned_chunk_count: 2 },
        chunks: [
          { text: "Oskar first-person relationship history." },
          { text: "Kaitlin first-person relationship history." },
        ],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before deleting Family AI files", async () => {
    const client = await createClient();

    const result = await client.callTool({
      name: "delete_file",
      arguments: {
        key_or_prefix: "medical/2026/kaitlin/birth_plan/duplicate.md",
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: "confirm_delete must be true.",
    });
  });

  it("deletes exact Family AI file artifacts from R2 and AI Search", async () => {
    const rawDelete = vi.fn(async () => undefined);
    const indexDelete = vi.fn(async () => undefined);
    const rawHead = vi.fn(async () => null);
    const indexHead = vi.fn(async () => ({ key: "medical/2026/kaitlin/birth_plan/duplicate.md" }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET" && url.includes("key=medical%2F2026%2Fkaitlin%2Fbirth_plan%2Fduplicate.md")) {
        return Response.json({ success: true, result: { items: [{ id: "item-123", key: "medical/2026/kaitlin/birth_plan/duplicate.md" }] } });
      }
      if (init?.method === "DELETE" && url.endsWith("/items/item-123")) {
        return Response.json({ success: true, result: {} });
      }
      return Response.json({ success: false, errors: [{ message: "unexpected request" }] }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = await createClient({
      CF_API_TOKEN: "test-token",
      R2_RAW: { head: rawHead, delete: rawDelete },
      R2_INDEX_READY: { head: indexHead, delete: indexDelete },
    });

    const result = await client.callTool({
      name: "delete_file",
      arguments: {
        key_or_prefix: "medical/2026/kaitlin/birth_plan/duplicate.md",
        buckets: "both",
        confirm_delete: true,
      },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      deleted_object_count: 1,
      deleted_objects: [{ bucket: "index_ready", key: "medical/2026/kaitlin/birth_plan/duplicate.md" }],
      missing_objects: [{ bucket: "raw", key: "medical/2026/kaitlin/birth_plan/duplicate.md" }],
      deleted_ai_search_item_count: 1,
      deleted_ai_search_items: [{ id: "item-123", key: "medical/2026/kaitlin/birth_plan/duplicate.md" }],
    });
    expect(rawDelete).not.toHaveBeenCalled();
    expect(indexDelete).toHaveBeenCalledWith("medical/2026/kaitlin/birth_plan/duplicate.md");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
