// Hono supplies the Worker router and typed request context.
import { Hono } from "hono";

// The uploader module attaches the service's document-management routes.
import { registerUploaderApi } from "./uploaderApi.js";

// This stable name identifies the Worker in health and discovery responses.
const SERVICE_NAME = "family-ai-core";

// This module-owned router is the Worker entrypoint exported to the runtime.
const app = new Hono<{ Bindings: Env }>();

app.get(
  "/health",
  /**
   * Input:
   * - A Hono request context with environment bindings.
   * Output:
   * - JSON showing service health, environment, and current time.
   * What this function does:
   * - Provides a simple health check for monitoring and debugging.
   */
  (c) => {
    return c.json({
      ok: true,
      service: SERVICE_NAME,
      env: c.env.APP_ENV,
      timestamp: new Date().toISOString(),
    });
  });

app.get(
  "/",
  /**
   * Input:
   * - A Hono request context.
   * Output:
   * - JSON identifying the service and its supported entry points.
   * What this function does:
   * - Explains that clients should use the uploader API or MCP tools.
   */
  (c) =>
    c.json({
      ok: true,
      service: SERVICE_NAME,
      message: "Frontend uploader removed. Use /api/uploader/* endpoints or MCP ingest tools.",
    })
);

registerUploaderApi(app);

app.notFound(
  /**
   * Input:
   * - A Hono context for a request that matched no route.
   * Output:
   * - A JSON 404 response.
   * What this function does:
   * - Gives unknown paths a consistent error response.
   */
  (c) => c.json({ ok: false, error: "Not found" }, 404)
);

export default app;
