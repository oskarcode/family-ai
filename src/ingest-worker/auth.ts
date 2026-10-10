// Worker bindings provide the optional Cloudflare Access service-token credentials.
import type { EnvBindings } from "./types.js";

/**
 * Input:
 * - No arguments.
 * Output:
 * - A JSON response with HTTP status 401.
 * What this function does:
 * - Returns the standard response for rejected Family AI MCP requests.
 */
export function unauthorizedResponse(): Response {
  return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

/**
 * Input:
 * - No arguments.
 * Output:
 * - A JSON response with HTTP status 500.
 * What this function does:
 * - Reports an incomplete Cloudflare Access credential configuration.
 */
export function misconfiguredAuthResponse(): Response {
  return Response.json(
    { ok: false, error: "Server auth misconfigured: set both ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET" },
    { status: 500 }
  );
}

/**
 * Input:
 * - An MCP request and the Worker's configured Access credentials.
 * Output:
 * - Authorization and configuration status flags.
 * What this function does:
 * - Validates Cloudflare Access service-token headers when auth is configured.
 */
export function isMcpRequestAuthorized(request: Request, env: EnvBindings): { ok: boolean; misconfigured: boolean } {
  const expectedId = (env.ACCESS_CLIENT_ID || "").trim();
  const expectedSecret = (env.ACCESS_CLIENT_SECRET || "").trim();

  if (!expectedId && !expectedSecret) return { ok: true, misconfigured: false };
  if (!expectedId || !expectedSecret) return { ok: false, misconfigured: true };

  const actualId = (request.headers.get("CF-Access-Client-Id") || "").trim();
  const actualSecret = (request.headers.get("CF-Access-Client-Secret") || "").trim();

  if (actualId !== expectedId || actualSecret !== expectedSecret) {
    return { ok: false, misconfigured: false };
  }

  return { ok: true, misconfigured: false };
}
