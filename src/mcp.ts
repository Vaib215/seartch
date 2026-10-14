// MCP server exposing /search and /fetch as tools (stateless Streamable HTTP via
// the Agents SDK's createMcpHandler). Tools call the same handlers as the REST
// endpoints, so validation and limits are shared.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PageResult } from "./fetch";
import { ENGINES } from "./searx/engines";
import type { MergedResult } from "./searx/results";
import { CATEGORIES } from "./searx/search";
import { errorMessage } from "./util";

export interface ToolBackends {
  search(body: Record<string, unknown>): Promise<{ results: SearchOut[] }>;
  fetch(body: Record<string, unknown>): Promise<{ results: PageResult[] }>;
}

type Hit = MergedResult & Partial<Pick<PageResult, "markdown" | "via" | "paywalled" | "partial" | "archivedAt">> & {
  contentError?: string;
};
interface SearchOut {
  query: string;
  results: Hit[];
  unresponsiveEngines: { engine: string; error: string; suspended: boolean }[];
  dropped?: { nonArticle: number; spam: number; offTopic: number; outOfRange: number };
  companies?: string[];
}

const DEFAULT_SEARCH_CONTENT_CHARS = 4000;
const DEFAULT_FETCH_CHARS = 20_000;

export function createServer(backends: ToolBackends): McpServer {
  const server = new McpServer({ name: "web-search-worker", version: "1.0.0" });

  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description:
        "Metasearch across many engines (a SearXNG port), tuned for Indian financial news and stock research. " +
        "Up to 5 queries per call. " +
        "For news and company research, set categories ['news'] (Indian publishers: ET, Mint, Business Standard, " +
        "Financial Express, CNBC TV18, BusinessLine and more; Google News; NSE filings; RBI/SEBI) and a timeRange; " +
        "add 'filings' for exchange announcements and board-meeting outcomes only. News mode drops off-topic stories, " +
        "listing/quote pages and spam, dates results from the article itself, and accepts sort 'date' for newest first. " +
        "Name the company plainly ('Tata Elxsi Q2 results', 'RIL dividend'); tickers and common names both work. " +
        "Supports SearXNG bangs ('!gh tokio', '!science attention'). includeContent returns each page as Markdown.",
      inputSchema: {
        queries: z.array(z.string().min(1)).min(1).max(5).describe("Search queries, run in parallel"),
        limit: z.number().int().min(1).max(30).optional().describe("Results per query (default 8)"),
        categories: z.array(z.enum(CATEGORIES as [string, ...string[]])).optional().describe("Engine categories (default general)"),
        engines: z
          .array(z.enum(ENGINES.map((e) => e.name) as [string, ...string[]]))
          .optional()
          .describe("Specific engines; overrides categories"),
        timeRange: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
        sort: z.enum(["relevance", "date"]).optional().describe('"date": newest first (undated last). Default relevance'),
        language: z.string().optional().describe('"all" (default), "en", "en-US", ...'),
        includeContent: z.boolean().optional().describe("Fetch each result page as Markdown (slower)"),
        maxContentChars: z.number().int().min(200).max(50_000).optional().describe("Per-page Markdown cap when includeContent (default 4000)"),
      },
    },
    async ({ maxContentChars, limit, ...args }) =>
      run(async () => {
        const out = await backends.search({ ...args, limit: limit ?? 8 });
        return out.results.map((r) => formatSearch(r, maxContentChars ?? DEFAULT_SEARCH_CONTENT_CHARS)).join("\n\n");
      }),
  );

  server.registerTool(
    "web_fetch",
    {
      title: "Fetch pages as Markdown",
      description:
        "Fetch up to 20 URLs and return each page's main content as Markdown. " +
        "Flags paywalled or partial articles. Optionally falls back to the Wayback Machine for blocked or dead pages.",
      inputSchema: {
        urls: z.array(z.string().url()).min(1).max(20),
        render: z
          .enum(["auto", "never", "always"])
          .optional()
          .describe("Headless-browser fallback for JS-heavy or blocked pages (default auto)"),
        archiveFallback: z.boolean().optional().describe("Use the latest Wayback Machine capture when the live page fails"),
        maxChars: z.number().int().min(200).max(200_000).optional().describe("Per-page Markdown cap (default 20000)"),
      },
    },
    async ({ maxChars, ...args }) =>
      run(async () => {
        const out = await backends.fetch(args);
        return out.results.map((p) => formatPage(p, maxChars ?? DEFAULT_FETCH_CHARS)).join("\n\n---\n\n");
      }),
  );

  return server;
}

async function run(fn: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await fn() }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
  }
}

function formatSearch(r: SearchOut, maxChars: number): string {
  const lines = [`## Results for "${r.query}"`];
  if (r.companies?.length) lines.push(`_Company: ${r.companies.join(", ")}_`);
  if (!r.results.length) lines.push("No results.");
  r.results.forEach((h, i) => {
    lines.push(`${i + 1}. [${h.title}](${h.url})`);
    const meta = [h.author, h.publishedDate?.slice(0, 10), `via ${h.engines.join(", ")}`].filter(Boolean).join(" · ");
    lines.push(`   ${meta}`);
    if (h.content) lines.push(`   ${h.content}`);
    if (h.markdown) {
      lines.push(`   ${accessNote(h)}Page content:`, indent(truncate(h.markdown, maxChars)));
    } else if (h.contentError) {
      lines.push(`   (content unavailable: ${h.contentError})`);
    }
  });
  const d = r.dropped;
  const droppedTotal = d ? d.nonArticle + d.spam + d.offTopic + d.outOfRange : 0;
  if (d && droppedTotal) {
    lines.push(`\n_Filtered out: ${d.offTopic} off-topic, ${d.nonArticle} listing/quote pages, ${d.spam} spam, ${d.outOfRange} outside the time range_`);
  }
  const down = r.unresponsiveEngines.map((u) => `${u.engine}${u.suspended ? " (suspended)" : ""}`);
  if (down.length) lines.push(`\n_Engines unavailable: ${down.join(", ")}_`);
  return lines.join("\n");
}

function formatPage(p: PageResult, maxChars: number): string {
  if (p.error) return `# ${p.url}\n\nError: ${p.error}`;
  const head = [`Source: ${p.finalUrl ?? p.url}`, `Retrieved via: ${p.via}`];
  if (p.via === "wayback") head.push(`Archived copy from ${p.archivedAt ?? "unknown date"} (live page: ${p.liveError})`);
  if (p.paywalled) head.push(accessNote(p).trim());
  return `${head.join("\n")}\n\n${truncate(p.markdown ?? "", maxChars)}`;
}

function accessNote(p: { paywalled?: boolean; partial?: boolean; via?: string; archivedAt?: string }): string {
  if (!p.paywalled) return p.via === "wayback" ? `[archived ${p.archivedAt ?? ""}] ` : "";
  return p.partial ? "[PAYWALLED: only a teaser or barrier page was available] " : "[paywalled article, full text retrieved] ";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n\n[... truncated, ${s.length - max} more characters]`;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `   > ${l}`)
    .join("\n");
}
