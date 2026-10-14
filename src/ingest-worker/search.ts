// Shared input and Worker binding types keep search aligned with tool schemas.
import type { EnvBindings, SearchInput } from "./types.js";

/**
 * Input:
 * - A family-document search query and optional AI Search controls.
 * Output:
 * - The AI Search binding result wrapped in the MCP search response envelope.
 * What this function does:
 * - Uses only the configured AI Search Worker binding.
 * - Fails clearly when the binding is absent.
 */
export async function searchFamilyDocuments(
  env: EnvBindings,
  input: SearchInput
): Promise<Record<string, unknown>> {
  if (!env.AI_SEARCH) return { success: false, error: "AI_SEARCH binding is required for this Worker." };

  try {
    const result = await env.AI_SEARCH.search({
      query: input.query,
      ai_search_options: input.ai_search_options as AiSearchOptions | undefined,
    });
    return { success: true, result };
  } catch (error) {
    return { success: false, error: `AI Search binding request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
