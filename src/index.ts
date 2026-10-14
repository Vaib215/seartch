import { createMcpHandler } from "agents/mcp/server";
import { RENDER_MODES, fetchPages, type PageResult, pdfToMarkdown } from "./fetch";
import { configureDocumentText } from "./searx/filing_text";
import { createServer } from "./mcp";
import { ENGINES, ENGINE_BY_NAME } from "./searx/engines";
import { EngineHealth } from "./searx/health";
import { configureTickerSearch, httpTickerLookup, resolveCompanies, tickerSearchConfigured, type TickerLookup } from "./searx/companies";
import { fetchPublishedDate } from "./searx/dates";
import { CATEGORIES, SORT_ORDERS, type SearchRequest, type SearchResponse, metasearch, runEngine } from "./searx/search";
import { type Category, type SafeSearch, type TimeRange, EngineError } from "./searx/types";
import { HttpError, errorMessage, intInRange, json, mapLimit, oneOf, readJson, stringList } from "./util";

export interface Env {
  AUTH_TOKEN?: string;
  BROWSER?: Fetcher;
  AI?: Ai;
  /** Fuzzy ticker-search service as a service binding (preferred for a Worker on the same account). */
  TICKER_SEARCH?: Fetcher;
  /** ...or its base URL. Either one enables company resolution and exchange filings. */
  TICKER_SEARCH_URL?: string;
}

const MAX_QUERIES = 5;
const MAX_RESULTS_PER_QUERY = 30;
const MAX_FETCH_URLS = 20;
// Upper bound on pages fetched for `includeContent`, across all queries.
const MAX_CONTENT_PAGES = 20;
// Each query fans out to many engines and Workers allow only 6 connections in
// flight, so queries run a couple at a time rather than all at once.
const QUERY_CONCURRENCY = 2;

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const { pathname } = new URL(req.url);
    configureTickerSearch(tickerLookupFor(env));
    const ai = env.AI;
    configureDocumentText(ai ? (url) => pdfToMarkdown(url, ai) : undefined);
    try {
      if (req.method === "GET" && pathname === "/") {
        return json({ ok: true, endpoints: ["POST /search", "POST /fetch", "GET /engines", "POST /engines/test", "/mcp"] });
      }
      await authorize(req, env);
      if (pathname === "/mcp") {
        const backends = {
          search: (body: Record<string, unknown>) => handleSearch(body, env),
          fetch: (body: Record<string, unknown>) => handleFetch(body, env),
        };
        return createMcpHandler(() => createServer(backends))(req, env, ctx);
      }
      if (req.method === "GET" && pathname === "/engines") return json(await listEngines(req));
      if (req.method !== "POST") throw new HttpError(405, "use POST");
      const body = await readJson(req);
      switch (pathname) {
        case "/search":
          return json(await handleSearch(body, env));
        case "/fetch":
          return json(await handleFetch(body, env));
        case "/engines/test":
          return json(await testEngines(body));
        case "/engines/reset":
          health.reset();
          return json({ ok: true });
        default:
          throw new HttpError(404, "not found");
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: errorMessage(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * POST /search
 * {
 *   "queries": ["..."], "limit": 10, "pageno": 1, "language": "all", "safesearch": 0,
 *   "timeRange": "week" | "quarter" | ..., "sort": "relevance" | "date",
 *   "categories": ["news", "filings", "general"], "engines": ["nse filings"],
 *   "verifyDates": true, "includeContent": false, "render": "auto", "archiveFallback": false
 * }
 * Queries support SearXNG bangs: "!gh rust http", "!it tokio".
 */
async function handleSearch(body: Record<string, unknown>, env: Env) {
  const queries = stringList(body.queries ?? body.query, "queries", MAX_QUERIES);
  const limit = intInRange(body.limit, "limit", 1, MAX_RESULTS_PER_QUERY, 10);
  const render = oneOf(body.render, "render", RENDER_MODES, "auto");
  const base = searchOptions(body);

  const state = health.snapshot();
  const responses: SearchResponse[] = await mapLimit(queries, QUERY_CONCURRENCY, (query) =>
    metasearch(
      { ...base, query },
      {
        health: state,
        recordOutcomes: (o) => health.record(o),
        cache: caches.default,
        publishedDate: (url) => fetchPublishedDate(url),
        resolveCompanies: tickerSearchConfigured() ? resolveCompanies : undefined,
      },
    ),
  );
  const results = responses.map((r) => ({ ...r, results: r.results.slice(0, limit) }));
  if (body.includeContent !== true) return { results };

  // Fetch each distinct URL once, up to the page cap, then attach content to every hit.
  const urls = [...new Set(results.flatMap((r) => r.results.map((h) => h.url)))].slice(0, MAX_CONTENT_PAGES);
  const archiveFallback = body.archiveFallback === true;
  const pages = new Map((await fetchPages(urls, env, { render, archiveFallback })).map((p) => [p.url, p]));
  return {
    results: results.map((r) => ({ ...r, results: r.results.map((h) => withContent(h, pages.get(h.url))) })),
  };
}

function searchOptions(body: Record<string, unknown>): Omit<SearchRequest, "query"> {
  const categories = body.categories === undefined ? undefined : stringList(body.categories, "categories", 10);
  for (const c of categories ?? []) {
    if (!(CATEGORIES as string[]).includes(c)) throw new HttpError(400, `unknown category "${c}"`);
  }
  const engines = body.engines === undefined ? undefined : stringList(body.engines, "engines", 50);
  for (const e of engines ?? []) {
    if (!ENGINE_BY_NAME.has(e)) throw new HttpError(400, `unknown engine "${e}"`);
  }
  const language = body.language === undefined ? "all" : stringList(body.language, "language", 1)[0];
  return {
    pageno: intInRange(body.pageno, "pageno", 1, 10, 1),
    language,
    safesearch: intInRange(body.safesearch, "safesearch", 0, 2, 0) as SafeSearch,
    timeRange:
      body.timeRange == null
        ? undefined
        : (oneOf(body.timeRange, "timeRange", ["day", "week", "month", "quarter", "year"] as const, "day") as TimeRange),
    sort: oneOf(body.sort, "sort", SORT_ORDERS, "relevance"),
    verifyDates: body.verifyDates !== false,
    categories: categories as Category[] | undefined,
    engines,
  };
}

function withContent<T extends { url: string }>(hit: T, page: PageResult | undefined) {
  if (!page) return { ...hit, contentError: `skipped: over the ${MAX_CONTENT_PAGES}-page content limit` };
  if (page.error) return { ...hit, contentError: page.error };
  const { markdown, via, paywalled, partial, paywallSignals, archivedAt } = page;
  return { ...hit, markdown, via, paywalled, partial, paywallSignals, archivedAt };
}

/**
 * POST /fetch
 * { "urls": ["https://..."], "render": "auto" | "never" | "always", "archiveFallback": false }
 */
async function handleFetch(body: Record<string, unknown>, env: Env) {
  const urls = stringList(body.urls ?? body.url, "urls", MAX_FETCH_URLS);
  const render = oneOf(body.render, "render", RENDER_MODES, "auto");
  const archiveFallback = body.archiveFallback === true;
  return { results: await fetchPages(urls, env, { render, archiveFallback }) };
}

/** GET /engines: every engine with its categories and current suspension state here. */
async function listEngines(req: Request) {
  const state = health.snapshot();
  const now = Date.now();
  return {
    colo: (req.cf?.colo as string | undefined) ?? "local",
    engines: ENGINES.map((e) => {
      const s = state[e.name];
      return {
        name: e.name,
        shortcut: e.shortcut,
        categories: e.categories,
        disabled: !!e.disabled,
        about: e.about,
        suspendedFor: s && s.suspendedUntil > now ? Math.round((s.suspendedUntil - now) / 1000) : 0,
        continuousErrors: s?.continuousErrors ?? 0,
        lastError: s?.reason,
      };
    }),
  };
}

/**
 * POST /engines/test { "query": "...", "engines": [...] }
 * Runs engines directly (no cache, no suspension) and reports what each returned.
 * Engines run sequentially so the 6-connection limit doesn't skew timings.
 */
async function testEngines(body: Record<string, unknown>) {
  const query = stringList(body.query ?? "rust programming language", "query", 1)[0];
  const names = body.engines === undefined ? ENGINES.map((e) => e.name) : stringList(body.engines, "engines", 50);
  const out = [];
  for (const name of names) {
    const engine = ENGINE_BY_NAME.get(name);
    if (!engine) {
      out.push({ engine: name, ok: false, error: "unknown engine" });
      continue;
    }
    const started = Date.now();
    try {
      const { results } = await runEngine(engine, { query, pageno: 1, language: "all", safesearch: 0 });
      out.push({ engine: name, ok: results.length > 0, ms: Date.now() - started, count: results.length, sample: results.slice(0, 3) });
    } catch (e) {
      const err = e instanceof EngineError ? `${e.kind}: ${e.message}` : errorMessage(e);
      out.push({ engine: name, ok: false, ms: Date.now() - started, error: err });
    }
  }
  return { query, results: out };
}

/** Engine suspension state, shared by every request this isolate serves. */
const health = new EngineHealth();

function tickerLookupFor(env: Env): TickerLookup | undefined {
  const post = (path: string, body: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body });
  if (env.TICKER_SEARCH) {
    const binding = env.TICKER_SEARCH;
    return httpTickerLookup((path, body) => binding.fetch(new Request(`https://ticker-search${path}`, post(path, body))));
  }
  if (env.TICKER_SEARCH_URL) {
    const base = env.TICKER_SEARCH_URL.replace(/\/+$/, "");
    return httpTickerLookup((path, body) => fetch(`${base}${path}`, { ...post(path, body), signal: AbortSignal.timeout(3000) }));
  }
  return undefined;
}

async function authorize(req: Request, env: Env) {
  if (!env.AUTH_TOKEN) throw new HttpError(500, "AUTH_TOKEN secret is not configured");
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Compare hashes so the comparison is constant-time regardless of token length.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(token)),
    crypto.subtle.digest("SHA-256", enc.encode(env.AUTH_TOKEN)),
  ]);
  if (!crypto.subtle.timingSafeEqual(a, b)) throw new HttpError(401, "unauthorized");
}
