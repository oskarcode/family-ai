// Node utilities load query fixtures, resolve output paths, and invoke Wrangler.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Validation types define query expectations and the AI Search response fields being measured.
type QuerySpec = {
  query: string;
  expectedCategory?: string;
};

type AiSearchStats = {
  queued: number;
  running: number;
  completed: number;
  error: number;
  skipped: number;
  outdated: number;
  last_activity: string;
};

type SearchChunk = {
  score?: number;
  text?: string;
  item?: { key?: string };
};

type SearchResult = {
  chunks?: SearchChunk[];
};

// Project-relative paths locate validation queries and generated quality reports.
const WORKDIR = process.cwd();
const OUTPUT_DIR = path.join(WORKDIR, "outputs", "migration");
const DEFAULT_QUERIES_PATH = path.join(WORKDIR, "docs", "search_validation_queries.json");

// CLI policy controls polling, timeouts, result depth, and the target search instance.
type CliConfig = {
  instanceId: string;
  wait: boolean;
  pollSeconds: number;
  timeoutMinutes: number;
  maxResults: number;
  queriesPath: string;
};

/**
 * Input:
 * - Command-line argument tokens.
 * Output:
 * - Search validation configuration with defaults and overrides.
 * What this function does:
 * - Parses instance, polling, timeout, result-limit, and query-file options.
 */
function parseArgs(argv: string[]): CliConfig {
  const config: CliConfig = {
    instanceId: "family-ai-chat-v3",
    wait: false,
    pollSeconds: 60,
    timeoutMinutes: 180,
    maxResults: 8,
    queriesPath: DEFAULT_QUERIES_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--instance" && argv[i + 1]) {
      config.instanceId = argv[++i];
      continue;
    }
    if (arg === "--wait") {
      config.wait = true;
      continue;
    }
    if (arg === "--poll-seconds" && argv[i + 1]) {
      config.pollSeconds = Number(argv[++i]);
      continue;
    }
    if (arg === "--timeout-minutes" && argv[i + 1]) {
      config.timeoutMinutes = Number(argv[++i]);
      continue;
    }
    if (arg === "--max-results" && argv[i + 1]) {
      config.maxResults = Number(argv[++i]);
      continue;
    }
    if (arg === "--queries" && argv[i + 1]) {
      config.queriesPath = path.resolve(argv[++i]);
      continue;
    }
  }

  return config;
}

/**
 * Input:
 * - Wrangler command arguments.
 * Output:
 * - Parsed JSON emitted by Wrangler.
 * What this function does:
 * - Executes a local Wrangler command with consistent JSON settings.
 */
function runWranglerJson(commandArgs: string[]): unknown {
  const out = execFileSync("npx", ["wrangler", ...commandArgs, "--json"], {
    cwd: WORKDIR,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * Input:
 * - A delay duration in milliseconds.
 * Output:
 * - A promise that resolves after the delay.
 * What this function does:
 * - Provides asynchronous pacing between indexing status polls.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Input:
 * - An optional indexed object key.
 * Output:
 * - Its leading category segment or "unknown".
 * What this function does:
 * - Derives category metadata from the canonical key structure.
 */
function extractCategoryFromKey(key?: string): string {
  if (!key) return "unknown";
  return key.split("/")[0] || "unknown";
}

/**
 * Input:
 * - Search validation configuration.
 * Output:
 * - The latest AI Search indexing statistics.
 * What this function does:
 * - Polls until indexing is idle, waiting is disabled, or timeout is exceeded.
 */
async function waitForIndexCompletion(config: CliConfig): Promise<AiSearchStats> {
  const started = Date.now();
  // Poll serially so each delay is measured from a completed status request, avoiding overlapping calls.
  while (true) {
    const stats = runWranglerJson(["ai-search", "stats", config.instanceId]) as AiSearchStats;
    const done = stats.queued === 0 && stats.running === 0;
    if (done) return stats;

    const elapsedMin = (Date.now() - started) / 1000 / 60;
    // Return a usable partial snapshot instead of blocking when wait mode is off or the deadline passes.
    if (!config.wait || elapsedMin > config.timeoutMinutes) {
      return stats;
    }

    console.log(
      `Index not finished yet (queued=${stats.queued}, running=${stats.running}). Waiting ${config.pollSeconds}s...`,
    );
    await sleep(config.pollSeconds * 1000);
  }
}

/**
 * Input:
 * - An expected category and ranked search chunks.
 * Output:
 * - Whether the highest-ranked chunk belongs to the expected category.
 * What this function does:
 * - Evaluates the primary category-relevance validation signal.
 */
function mainCategoryMatch(expectedCategory: string | undefined, chunks: SearchChunk[]): boolean {
  if (!expectedCategory || chunks.length === 0) return false;
  const top = chunks[0];
  return extractCategoryFromKey(top.item?.key) === expectedCategory;
}

/**
 * Input:
 * - Ranked search chunks and the number of leading scores to include.
 * Output:
 * - The arithmetic mean of the selected scores.
 * What this function does:
 * - Measures top-result strength while treating missing scores as zero.
 */
function avgTopScore(chunks: SearchChunk[], n = 3): number {
  const selected = chunks.slice(0, n).map((c) => c.score ?? 0);
  if (selected.length === 0) return 0;
  return selected.reduce((a, b) => a + b, 0) / selected.length;
}

/**
 * Input:
 * - Ranked search chunks.
 * Output:
 * - The fraction of chunks containing a source object key.
 * What this function does:
 * - Measures whether returned evidence can be traced to indexed sources.
 */
function citationCoverage(chunks: SearchChunk[]): number {
  if (chunks.length === 0) return 0;
  const withKey = chunks.filter((c) => Boolean(c.item?.key)).length;
  return withKey / chunks.length;
}

/**
 * Input:
 * - CLI arguments, validation query specs, and live AI Search results.
 * Output:
 * - JSON and Markdown search validation reports on disk.
 * What this function does:
 * - Executes test queries and summarizes relevance and citation metrics.
 */
async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const queries = JSON.parse(fs.readFileSync(config.queriesPath, "utf8")) as QuerySpec[];
  const statsBefore = runWranglerJson(["ai-search", "stats", config.instanceId]) as AiSearchStats;
  const statsAtValidation = await waitForIndexCompletion(config);

  const queryResults = queries.map(
    /**
     * Input:
     * - One validation query specification.
     * Output:
     * - Per-query retrieval, scoring, citation, and category metrics.
     * What this function does:
     * - Executes and evaluates one AI Search validation query.
     */
    (spec) => {
      const result = runWranglerJson([
        "ai-search",
        "search",
        config.instanceId,
        "--query",
        spec.query,
        "--max-num-results",
        String(config.maxResults),
      ]) as SearchResult;
      const chunks = result.chunks ?? [];

      const topCategories = Array.from(new Set(chunks.slice(0, 5).map((c) => extractCategoryFromKey(c.item?.key))));
      const topKeys = chunks.slice(0, 5).map((c) => c.item?.key ?? "");
      const topScore = chunks[0]?.score ?? 0;

      // Keep raw result counts separate from normalized quality metrics for transparent validation.
      return {
        query: spec.query,
        expected_category: spec.expectedCategory ?? "",
        result_count: chunks.length,
        top_score: Number(topScore.toFixed(4)),
        avg_top3_score: Number(avgTopScore(chunks, 3).toFixed(4)),
        citation_coverage: Number(citationCoverage(chunks).toFixed(4)),
        top_category_match: mainCategoryMatch(spec.expectedCategory, chunks),
        top_categories: topCategories,
        top_keys: topKeys,
      };
    },
  );

  const totalQueries = queryResults.length;
  const withResults = queryResults.filter((r) => r.result_count > 0).length;
  const topCategoryMatched = queryResults.filter((r) => r.top_category_match).length;
  // Guard empty query sets so aggregate validation metrics remain finite and reportable.
  const avgCitation = queryResults.reduce((sum, r) => sum + r.citation_coverage, 0) / Math.max(1, totalQueries);
  const avgScore = queryResults.reduce((sum, r) => sum + r.avg_top3_score, 0) / Math.max(1, totalQueries);

  const payload = {
    generated_at: new Date().toISOString(),
    instance_id: config.instanceId,
    queries_path: config.queriesPath,
    wait_mode: config.wait,
    stats_before_validation: statsBefore,
    stats_at_validation: statsAtValidation,
    summary: {
      total_queries: totalQueries,
      queries_with_results: withResults,
      top_category_match_count: topCategoryMatched,
      avg_citation_coverage: Number(avgCitation.toFixed(4)),
      avg_top3_score: Number(avgScore.toFixed(4)),
    },
    query_results: queryResults,
  };

  const markdown = `# Search Validation Report\n\n- Generated at: ${payload.generated_at}\n- Instance: \`${config.instanceId}\`\n- Wait mode: **${config.wait ? "on" : "off"}**\n\n## Index State At Validation\n\n- queued: **${statsAtValidation.queued}**\n- running: **${statsAtValidation.running}**\n- completed: **${statsAtValidation.completed}**\n- error: **${statsAtValidation.error}**\n- skipped: **${statsAtValidation.skipped}**\n- outdated: **${statsAtValidation.outdated}**\n\n## Search Quality Summary\n\n- Total queries: **${totalQueries}**\n- Queries with at least one result: **${withResults}**\n- Top-category matches (expected vs top hit): **${topCategoryMatched}/${totalQueries}**\n- Avg citation coverage: **${(avgCitation * 100).toFixed(1)}%**\n- Avg top-3 score: **${avgScore.toFixed(4)}**\n\n## Query Details\n\n${queryResults
  .map(
    (r, i) =>
      `${i + 1}. \`${r.query}\`\n   - expected: ${r.expected_category || "n/a"}\n   - results: ${r.result_count}\n   - top score: ${r.top_score}\n   - top category match: ${r.top_category_match}\n   - top categories: ${r.top_categories.join(", ") || "none"}`,
  )
  .join("\n\n")}\n\n## Next Plan\n\n1. If queued/running are non-zero, rerun with \`--wait\` for final quality check.\n2. Review mismatched queries and tune metadata/category mapping.\n3. Add filter-based validation per person/sensitivity class before production use.\n`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "search_validation_report.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, "search_validation_report.md"), markdown);

  console.log("Search validation report generated:");
  console.log(`- ${path.join(OUTPUT_DIR, "search_validation_report.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "search_validation_report.md")}`);
}

main().catch(
  /**
   * Input:
   * - An unhandled validation failure.
   * Output:
   * - No return value; logs the failure and exits unsuccessfully.
   * What this function does:
   * - Converts top-level asynchronous failures into CLI error behavior.
   */
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
