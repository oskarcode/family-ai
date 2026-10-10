// Agents SDK integration adapts the MCP server to the Worker runtime.
import { createMcpHandler } from "agents/mcp";

// Local modules provide request authorization, service metadata, and tool registration.
import {
  isMcpRequestAuthorized,
  misconfiguredAuthResponse,
  unauthorizedResponse,
} from "./auth.js";
import { SERVER_VERSION, TOOL_SCHEMA_VERSION } from "./config.js";
import { createUnifiedServer } from "./server.js";
import type { EnvBindings } from "./types.js";

// Re-export the server factory for tests and alternate runtime adapters.
export { createUnifiedServer } from "./server.js";

// The default export is the Worker entrypoint used by the deployment runtime.
export default {
  /**
   * Input:
   * - An HTTP request, Family AI environment bindings, and the Worker execution context.
   * Output:
   * - A health response, route error, auth error, or MCP protocol response.
   * What this function does:
   * - Routes health and authenticated MCP requests to the unified Family AI server.
   */
  async fetch(request: Request, env: EnvBindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "family-ai-mcp",
        server_version: SERVER_VERSION,
        tool_schema_version: TOOL_SCHEMA_VERSION,
        tools: ["family_ai_server_info", "search", "delete_file", "ingest_validate_file", "ingest_upload_validated_file", "ingest_chatgpt_file", "ingest_generated_text", "ingest_status"],
        env: env.APP_ENV,
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname !== "/mcp") {
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    }

    const auth = isMcpRequestAuthorized(request, env);
    if (!auth.ok) return auth.misconfigured ? misconfiguredAuthResponse() : unauthorizedResponse();

    const server = createUnifiedServer(env);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<EnvBindings>;
