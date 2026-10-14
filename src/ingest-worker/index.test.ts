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

// Minimal test bindings identify the service while individual tests inject storage/search fakes.
const baseEnv = {
  APP_ENV: "test",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  AI_SEARCH_INSTANCE_ID: "test-instance",
  AI_SEARCH_NAMESPACE: "default",
};

function createAiSearch(overrides: Partial<AiSearchInstance> = {}) {
  const items = {
    upload: vi.fn(async (key: string) => ({ id: "item-123", key, status: "queued" })),
    list: vi.fn(async () => ({ result: [{ id: "item-123", key: "general/2026/shared/note/test__abcd.md", status: "completed" }] })),
    delete: vi.fn(async () => undefined),
    get: vi.fn((id: string) => ({ info: vi.fn(async () => ({ id, key: "some-key.md", status: "completed" })) })),
  };
  return {
    search: vi.fn(async () => ({
      query_kind: "text",
      search_query: "mortgage",
      chunks: [{
        id: "chunk-1",
        type: "text",
        score: 0.91,
        text: "Mortgage evidence",
        item: { key: "financial/2026/shared/mortgage.md" },
      }],
    })),
    items,
    jobs: { create: vi.fn() },
    ...overrides,
  } as unknown as AiSearchInstance & { items: typeof items };
}

/**
 * Input:
 * - Optional Worker binding overrides for the test scenario.
 * Output:
 * - A connected in-memory MCP client.
 * What this function does:
 * - Creates the unified server and links it to a client without opening a network connection.
 */
async function createClient(envOverrides: Record<string, unknown> = {}) {
  const server = createUnifiedServer({ ...baseEnv, AI_SEARCH: createAiSearch(), ...envOverrides } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "manifest-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("unified Family AI MCP manifest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes binding-only search and ingestion tools with output schemas", async () => {
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

    const search = tools.find((tool) => tool.name === "search");
    expect(search?.inputSchema.properties).toHaveProperty("query");
    expect(search?.inputSchema.properties).not.toHaveProperty("source_prefixes");

    const upload = tools.find((tool) => tool.name === "ingest_upload_validated_file");
    expect(upload?.inputSchema.required).toEqual(["validation_id", "filename", "file_base64"]);
    expect(upload?.inputSchema.properties).not.toHaveProperty("index_markdown_fallback");

    const chatGptFile = tools.find((tool) => tool.name === "ingest_chatgpt_file");
    expect(chatGptFile?.inputSchema.required).toEqual(["file"]);
    expect(chatGptFile?._meta?.["openai/fileParams"]).toEqual(["file"]);
  });

  it("returns machine-readable unified server information without fallback fields", async () => {
    const client = await createClient();
    const result = await client.callTool({ name: "family_ai_server_info", arguments: {} });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      service: "family-ai-mcp",
      server_version: "1.5.1",
      tool_schema_version: 8,
      required_upload_fields: ["validation_id", "filename", "file_base64"],
    });
    expect((result.structuredContent as Record<string, string[]>).optional_upload_fields).toContain("logical_folder");
    expect((result.structuredContent as Record<string, string[]>).optional_upload_fields).not.toContain("index_markdown_fallback");
  });

  it("ingests a ChatGPT file-param download through R2 raw and AI Search binding", async () => {
    const rawPut = vi.fn(async () => undefined);
    const aiSearch = createAiSearch();
    const fetchMock = vi.fn(async () => new Response("chatgpt original bytes", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "22" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await createClient({ R2_RAW: { put: rawPut }, AI_SEARCH: aiSearch });

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
      metadata: { category: "general", year: "2026", person: "shared", doc_type: "chatgpt_note", original_preserved: true },
      index_keys: [expect.objectContaining({ mode: "ai_search_builtin" })],
    });
    expect(rawPut).toHaveBeenCalledOnce();
    expect(aiSearch.items.upload).toHaveBeenCalledOnce();
  });

  it("rejects oversized ChatGPT file downloads before storing bytes", async () => {
    const rawPut = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("too large", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": String(10 * 1024 * 1024 + 1) },
    })));
    const client = await createClient({ R2_RAW: { put: rawPut } });

    const result = await client.callTool({
      name: "ingest_chatgpt_file",
      arguments: { file: { download_url: "https://files.example/download/large-file", file_id: "file_large", mime_type: "text/plain", file_name: "large-note.txt" } },
    });

    expect(result.structuredContent).toMatchObject({ ok: false, error: "File exceeds max upload size (10485760 bytes)." });
    expect(rawPut).not.toHaveBeenCalled();
  });

  it("stores generated Markdown with explicit derived-document provenance", async () => {
    const rawPut = vi.fn(async () => undefined);
    const aiSearch = createAiSearch();
    const client = await createClient({ PREFLIGHT_SIGNING_SECRET: "test-signing-secret", R2_RAW: { put: rawPut }, AI_SEARCH: aiSearch });

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
    expect(aiSearch.items.upload).toHaveBeenCalledOnce();
  });

  it("searches only through the AI Search binding", async () => {
    const aiSearch = createAiSearch();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await createClient({ AI_SEARCH: aiSearch });

    const result = await client.callTool({ name: "search", arguments: { query: "mortgage" } });

    expect(result.structuredContent).toMatchObject({
      success: true,
      result: { search_query: "mortgage", chunks: [{ score: 0.91, item: { key: "financial/2026/shared/mortgage.md" } }] },
    });
    expect(aiSearch.search).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before deleting Family AI files", async () => {
    const client = await createClient();

    const result = await client.callTool({
      name: "delete_file",
      arguments: { key_or_prefix: "medical/2026/kaitlin/birth_plan/duplicate.md" },
    });

    expect(result.structuredContent).toMatchObject({ ok: false, error: "confirm_delete must be true." });
  });

  it("deletes exact Family AI raw artifact and matching AI Search item", async () => {
    const rawDelete = vi.fn(async () => undefined);
    const rawHead = vi.fn(async () => ({ key: "general/2026/shared/note/test__abcd.md" }));
    const aiSearch = createAiSearch();
    const client = await createClient({
      R2_RAW: { head: rawHead, delete: rawDelete },
      AI_SEARCH: aiSearch,
    });

    const result = await client.callTool({
      name: "delete_file",
      arguments: { key_or_prefix: "general/2026/shared/note/test__abcd.md", confirm_delete: true },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      deleted_object_count: 1,
      deleted_objects: [{ bucket: "raw", key: "general/2026/shared/note/test__abcd.md" }],
      deleted_ai_search_item_count: 1,
      deleted_ai_search_items: [{ id: "item-123", key: "general/2026/shared/note/test__abcd.md" }],
    });
    expect(rawDelete).toHaveBeenCalledWith("general/2026/shared/note/test__abcd.md");
    expect(aiSearch.items.delete).toHaveBeenCalledWith("item-123");
  });
});
