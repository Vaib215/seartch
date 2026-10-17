import { createMcpHandler } from "agents/mcp/server";
import { RENDER_MODES, fetchPages, type PageResult, pdfToMarkdown } from "./fetch";
import { configureDocumentText } from "./searx/filing_text";
import { createServer } from "./mcp";
import { ENGINES, ENGINE_BY_NAME } from "./searx/engines";
import { EngineHealth } from "./searx/health";
import { configureTickerSearch, httpTickerBatch, httpTickerLookup, resolveCompanies, tickerSearchConfigured } from "./searx/companies";
import { fetchPublishedDate } from "./searx/dates";
import { configureTinyfish } from "./searx/tinyfish";
import { CATEGORIES, SORT_ORDERS, type SearchRequest, type SearchResponse, metasearch, runEngine } from "./searx/search";
import { type Category, type DocType, type SafeSearch, type TimeRange, DOC_TYPES, EngineError } from "./searx/types";
import { HttpError, errorMessage, intInRange, json, mapLimit, oneOf, readJson, stringList } from "./util";

export interface Env {
  AUTH_TOKEN?: string;
  BROWSER?: Fetcher;
  AI?: Ai;
  /** Fuzzy ticker-search service as a service binding (preferred for a Worker on the same account). */
  TICKER_SEARCH?: Fetcher;
  /** ...or its base URL. Either one enables company resolution and exchange filings. */
  TICKER_SEARCH_URL?: string;
  /** Keys (comma-separated) for the TinyFish engines, by route: direct, through treg, through Monid. */
  TINYFISH_API_KEYS?: string;
  TREG_API_KEYS?: string;
  MONID_API_KEYS?: string;
  /** Deployment version (version_metadata binding); keys caches so a deploy starts fresh. */
  CF_VERSION_METADATA?: { id: string };
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
    const tickerCall = tickerCallFor(env);
    configureTickerSearch(tickerCall && httpTickerLookup(tickerCall), tickerCall && httpTickerBatch(tickerCall));
    configureTinyfish({ tinyfish: env.TINYFISH_API_KEYS, treg: env.TREG_API_KEYS, monid: env.MONID_API_KEYS });
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
 * Queries support SearXNG bangs: "!et polycab", "!filings tata elxsi".
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
        cacheVersion: env.CF_VERSION_METADATA?.id,
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
  const docTypes = body.docTypes === undefined ? undefined : stringList(body.docTypes, "docTypes", DOC_TYPES.length);
  for (const d of docTypes ?? []) {
    if (!(DOC_TYPES as string[]).includes(d)) throw new HttpError(400, `unknown docType "${d}" (one of ${DOC_TYPES.join(", ")})`);
  }
  return {
    pageno: intInRange(body.pageno, "pageno", 1, 10, 1),
    language,
    safesearch: intInRange(body.safesearch, "safesearch", 0, 2, 0) as SafeSearch,
    timeRange:
      body.timeRange == null
        ? undefined
        : (oneOf(body.timeRange, "timeRange", ["day", "week", "month", "quarter", "year"] as const, "day") as TimeRange),
    sort: oneOf(body.sort, "sort", SORT_ORDERS, "relevance"),
    company: typeof body.company === "string" && body.company.trim() ? body.company.trim().slice(0, 100) : undefined,
    verifyDates: body.verifyDates !== false,
    docTypes: docTypes as DocType[] | undefined,
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
 * { "urls": ["https://..."], "render": "auto" | "never" | "always", "archiveFallback": false,
 *   "pageStart": 1, "maxPages": 60, "maxChars": 60000, "focus": "working capital and net debt" }
 * Long PDFs come back in parts: when `truncated`, call again with `pageStart: nextPage`.
 * `focus` returns `passages` (with their PDF page) that best answer it instead of the whole text.
 */
async function handleFetch(body: Record<string, unknown>, env: Env) {
  const urls = stringList(body.urls ?? body.url, "urls", MAX_FETCH_URLS);
  const render = oneOf(body.render, "render", RENDER_MODES, "auto");
  const archiveFallback = body.archiveFallback === true;
  const pageStart = intInRange(body.pageStart, "pageStart", 1, 100_000, 1);
  const maxPages = body.maxPages == null ? undefined : intInRange(body.maxPages, "maxPages", 1, 10_000, 60);
  const maxChars = body.maxChars == null ? undefined : intInRange(body.maxChars, "maxChars", 200, 500_000, 60_000);
  const focus = typeof body.focus === "string" && body.focus.trim() ? body.focus.trim().slice(0, 500) : undefined;
  return { results: await fetchPages(urls, env, { render, archiveFallback, pageStart, maxPages, maxChars, focus }) };
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
  const query = stringList(body.query ?? "Nifty 50 today", "query", 1)[0];
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

function tickerCallFor(env: Env): ((path: string, body: string) => Promise<Response>) | undefined {
  const post = (path: string, body: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body });
  if (env.TICKER_SEARCH) {
    const binding = env.TICKER_SEARCH;
    return (path, body) => binding.fetch(new Request(`https://ticker-search${path}`, post(path, body)));
  }
  if (env.TICKER_SEARCH_URL) {
    const base = env.TICKER_SEARCH_URL.replace(/\/+$/, "");
    return (path, body) => fetch(`${base}${path}`, { ...post(path, body), signal: AbortSignal.timeout(3000) });
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
