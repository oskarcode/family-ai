// Vitest supplies the test structure and assertions.
import { describe, expect, it } from "vitest";

// Hono creates the in-memory Worker application used by integration coverage.
import { Hono } from "hono";

// The uploader exports under test cover planning and route registration behavior.
import { buildUploadPlan, registerUploaderApi, type UploadInput } from "./uploaderApi.js";

/**
 * Input:
 * - Optional upload fields that should differ from the standard valid fixture.
 * Output:
 * - A complete confirmed upload input suitable for planning tests.
 * What this function does:
 * - Builds a valid baseline fixture and applies only the requested overrides.
 */
function input(overrides: Partial<UploadInput> = {}): UploadInput {
  return {
    file: null,
    source_path: "uploaded/note.md",
    filename: "note.md",
    extension: "md",
    size_bytes: 5,
    mime_type: "text/markdown",
    approved_by: "family-user",
    category: "financial",
    custom_category: null,
    year: "2026",
    person: "oskar",
    doc_type: "note",
    sensitivity: "family",
    is_confirmed: true,
    ...overrides,
  };
}

/**
 * Input:
 * - Text content for a test file.
 * Output:
 * - UTF-8 bytes in the ArrayBuffer shape accepted by the upload planner.
 * What this function does:
 * - Converts readable fixture text into the Worker's binary input format.
 */
function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe("buildUploadPlan", () => {
  it("normalizes aliases and accepts relationship", /**
   * Input:
   * - Confirmed uploads using an alias and the relationship category.
   * Output:
   * - Assertions for canonical storage category keys.
   * What this function does:
   * - Keeps both uploader paths aligned with the shared taxonomy.
   */
  async () => {
    const finance = await buildUploadPlan(input({ category: "finance" }), bytes("hello"));
    const relationship = await buildUploadPlan(input({ category: "relationship" }), bytes("hello"));
    if ("error" in finance) throw new Error(finance.error);
    if ("error" in relationship) throw new Error(relationship.error);
    expect(finance.plan.categoryKey).toBe("financial");
    expect(relationship.plan.categoryKey).toBe("relationship");
  });

  it("rejects the retired family category", /**
   * Input:
   * - A confirmed upload using `family` as either a standard or custom category.
   * Output:
   * - Validation errors for both bypass paths.
   * What this function does:
   * - Prevents the retired prefix from being recreated by the core uploader.
   */
  async () => {
    await expect(buildUploadPlan(input({ category: "family" }), bytes("hello"))).resolves.toMatchObject({ status: 400 });
    await expect(buildUploadPlan(input({ category: null, custom_category: "family" }), bytes("hello"))).resolves.toMatchObject({ status: 400 });
  });

  it(
    "supports direct indexing for markdown",
    /**
     * Input:
     * - The standard valid Markdown upload fixture.
     * Output:
     * - Assertions that the planner selects direct indexing without a block.
     * What this function does:
     * - Verifies supported Markdown remains unchanged in the index-ready plan.
     */
    async () => {
    const result = await buildUploadPlan(input(), bytes("hello"));
    if ("error" in result) throw new Error(result.error);
    expect(result.plan.wouldIndex).toBe(true);
    expect(result.plan.indexingMode).toBe("direct");
    expect(result.plan.blockedReason).toBeNull();
    expect(result.plan.conversionDetails?.strategy).toBe("none");
    }
  );

  it(
    "converts jsonc to txt indexing payload",
    /**
     * Input:
     * - A JSONC upload that requires text-like conversion.
     * Output:
     * - Assertions that the planner creates a converted text payload.
     * What this function does:
     * - Verifies JSONC uses the generic text conversion path and a .txt key.
     */
    async () => {
    const result = await buildUploadPlan(
      input({ filename: "wrangler.jsonc", extension: "jsonc", mime_type: "application/json" }),
      bytes('{"a":1}//comment')
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.plan.wouldIndex).toBe(true);
    expect(result.plan.indexingMode).toBe("converted");
    expect(result.plan.conversionDetails?.strategy).toBe("text_to_text");
    expect(result.plan.indexKey?.endsWith(".txt")).toBe(true);
    }
  );

  it(
    "blocks auto indexing when policy requires split_then_index",
    /**
     * Input:
     * - A PDF large enough to trigger the split-first policy.
     * Output:
     * - Assertions that upload-time indexing is blocked by policy.
     * What this function does:
     * - Verifies policy precedence prevents direct indexing of oversized documents.
     */
    async () => {
    const largePdf = new ArrayBuffer(5 * 1024 * 1024);
    const result = await buildUploadPlan(
      input({ filename: "big.pdf", extension: "pdf", mime_type: "application/pdf", size_bytes: 5 * 1024 * 1024 }),
      largePdf
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.plan.wouldIndex).toBe(false);
    expect(result.plan.blockedReason).toBe("policy_block");
    }
  );

  it(
    "blocks indexing when converted payload exceeds 4MB",
    /**
     * Input:
     * - A convertible text payload larger than the search service limit.
     * Output:
     * - Assertions that indexing is blocked by final payload size.
     * What this function does:
     * - Verifies the post-conversion size guard independently of format support.
     */
    async () => {
    const hugeText = "a".repeat(4 * 1024 * 1024 + 1000);
    const result = await buildUploadPlan(
      input({ filename: "huge.jsonc", extension: "jsonc", mime_type: "application/json", size_bytes: hugeText.length }),
      bytes(hugeText)
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.plan.wouldIndex).toBe(false);
    expect(result.plan.blockedReason).toBe("size_limit");
    }
  );
});

describe("uploader API integration", () => {
  it(
    "persists custom category key and label on save",
    /**
     * Input:
     * - A confirmed multipart upload with a user-defined category label.
     * Output:
     * - Assertions covering the HTTP response and captured D1 insert arguments.
     * What this function does:
     * - Verifies save persists both the sanitized category key and original label.
     */
    async () => {
    const app = new Hono<{ Bindings: Env }>();
    registerUploaderApi(app);

    const captured: Array<{ sql: string; args: unknown[] }> = [];

    const env: Env = {
      APP_ENV: "dev",
      R2_RAW: { put: async () => null } as unknown as R2Bucket,
      R2_INDEX_READY: { put: async () => null } as unknown as R2Bucket,
      R2_PROCESSED: {} as R2Bucket,
      PROCESSING_QUEUE: { send: async () => undefined } as unknown as Queue,
      DB: {
        /**
         * Input:
         * - SQL prepared by the uploader save route.
         * Output:
         * - A fake statement that can capture values supplied through bind.
         * What this function does:
         * - Preserves each SQL string so the test can inspect document persistence.
         */
        prepare(sql: string) {
          return {
            /**
             * Input:
             * - Values bound to the prepared D1 statement.
             * Output:
             * - A captured statement compatible with the fake batch call.
             * What this function does:
             * - Records SQL arguments in execution order for persistence assertions.
             */
            bind(...args: unknown[]) {
              const stmt = { sql, args };
              captured.push(stmt);
              return stmt;
            },
          } as unknown as D1PreparedStatement;
        },
        /**
         * Input:
         * - The prepared statements passed by the save route.
         * Output:
         * - An empty successful D1 batch result.
         * What this function does:
         * - Completes the persistence boundary after prepare and bind capture the writes.
         */
        async batch() {
          return [] as unknown as D1Result<Record<string, unknown>>[];
        },
      } as unknown as D1Database,
    };

    const form = new FormData();
    form.append("file", new File(["ok"], "note.md", { type: "text/markdown" }));
    form.append("custom_category", "kids activities");
    form.append("year", "2026");
    form.append("person", "shared");
    form.append("is_confirmed", "true");

    const req = new Request("http://localhost/api/uploader/save", { method: "POST", body: form });
    const res = await app.fetch(req, env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    const body = (await res.json()) as { ok: boolean; metadata: { category: string; custom_category_label: string | null } };

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.metadata.category).toBe("kids-activities");
    expect(body.metadata.custom_category_label).toBe("kids activities");

    const documentInsert = captured.find((stmt) => stmt.sql.includes("INSERT INTO documents"));
    expect(documentInsert).toBeTruthy();
    expect(documentInsert?.args[6]).toBe("kids-activities");
    expect(documentInsert?.args[7]).toBe("kids activities");
    }
  );
});
