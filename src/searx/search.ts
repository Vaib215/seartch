// Port of searx/search/__init__.py + processors/online.py: pick engines, run
// them in parallel under a time budget, merge, and record engine health.

import { ENGINES, ENGINE_BY_NAME, ENGINE_BY_SHORTCUT } from "./engines";
import type { EngineState, Outcome } from "./health";
import { outcomeFromError } from "./health";
import { raiseForHttpError, send } from "./http";
import type { Company } from "./companies";
import { type CompanyLike, isAbout, isJunkPage, isNonArticle, isSpam } from "./news_filter";
import { type MergedResult, ResultContainer } from "./results";
import { splitQuery, termHits, topicTerms } from "./terms";
import {
  type Category,
  type Engine,
  type EngineContext,
  type EngineResult,
  type SearchParams,
  type TimeRange,
  EngineError,
} from "./types";

export const CATEGORIES: Category[] = ["general", "news", "filings", "ratings", "analysis"];

const DEFAULT_TIMEOUT_MS = 3000;
const CACHE_TTL_SECONDS = 1800;

const DAY_MS = 86_400_000;
const TIME_RANGE_MS: Record<TimeRange, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 91 * DAY_MS,
  year: 365 * DAY_MS,
};
// Publishers and engines disagree by hours on "today"; don't cut exactly at the edge.
const RANGE_SLACK_MS = DAY_MS;
const PASSING_MENTION_WEIGHT = 0.4;
// Reserve engines run when fewer results than this are about the query's company.
const FALLBACK_BELOW = 5;
// "Infosys deal wins": stories about Infosys but not about deals rank below those
// that are, and are dropped altogether once enough on-topic stories exist.
const TOPIC_MISS_WEIGHT = 0.35;
const TOPIC_DROP_MIN_MATCHES = 3;
// News mode reads page metadata to date this many top undated results.
const DATE_CHECKS = 6;
const DATE_CHECK_CONCURRENCY = 4;

export type SortOrder = "relevance" | "date";
export const SORT_ORDERS: SortOrder[] = ["relevance", "date"];

export interface SearchRequest extends SearchParams {
  /** Explicit engine names. Overrides categories. Disabled engines run when named. */
  engines?: string[];
  categories?: Category[];
  /** "date": newest first (undated results last). Default "relevance". */
  sort?: SortOrder;
  /** The company the query is about, when the caller knows it; resolved instead of the query text. */
  company?: string;
  /** News mode: read page metadata to date the top undated results. Default true. */
  verifyDates?: boolean;
}

export interface UnresponsiveEngine {
  engine: string;
  error: string;
  suspended: boolean;
}

export interface Timing {
  engine: string;
  ms: number;
  results: number;
  cached?: boolean;
}

export interface SearchResponse {
  query: string;
  results: MergedResult[];
  unresponsiveEngines: UnresponsiveEngine[];
  timings: Timing[];
  /** News mode: how many results were removed, and why. */
  dropped?: { nonArticle: number; spam: number; offTopic: number; outOfRange: number };
  /** News mode: companies the query was resolved to. */
  companies?: string[];
  /** News mode with a company and topic ("Infosys deal wins"): the topic words and how many results match them. */
  topic?: { terms: string[]; matched: number };
}

export interface SearchDeps {
  /** Current engine suspension state for this data center. */
  health: Record<string, EngineState>;
  /** Persists outcomes (fire-and-forget). */
  recordOutcomes(outcomes: Outcome[]): void;
  cache?: Cache;
  /** Distinguishes cache entries per deployment (the Worker version id). */
  cacheVersion?: string;
  /** Resolves company names/tickers in a query; enables company-aware relevance in news mode. */
  resolveCompanies?(query: string): Promise<Company[]>;
  /** Reads an article's publish date from its page; used in news mode for undated results. */
  publishedDate?(url: string): Promise<string | undefined>;
}

// Survives across requests within one isolate, like SearXNG's module globals.
const memo: EngineContext["memo"] = new Map();

/**
 * SearXNG's bang syntax (searx/query.py, simplified): `!et foo` selects the
 * engine with shortcut/name "et"; `!filings foo` selects a category.
 */
export function parseBangs(query: string): { query: string; engines: string[]; categories: Category[] } {
  const engines: string[] = [];
  const categories: Category[] = [];
  const rest: string[] = [];
  for (const word of query.split(/\s+/).filter(Boolean)) {
    const bang = word.startsWith("!") && word.length > 1 ? word.slice(1).toLowerCase().replace(/_/g, " ") : undefined;
    // A category name wins over an engine of the same name: `!analysis` is the whole category.
    const category = bang && (CATEGORIES as string[]).includes(bang) ? (bang as Category) : undefined;
    const engine = bang && !category ? (ENGINE_BY_SHORTCUT.get(bang) ?? ENGINE_BY_NAME.get(bang)) : undefined;
    if (category) categories.push(category);
    else if (engine) engines.push(engine.name);
    else rest.push(word);
  }
  return { query: rest.join(" "), engines, categories };
}

/** Companies for the request: the caller's `company` if given (resolved, else taken as a name), else the query's. */
async function resolveFor(company: string | undefined, query: string, deps: SearchDeps): Promise<Company[]> {
  if (!deps.resolveCompanies) {
    return company ? [{ name: company, aliases: [company.toLowerCase()] }] : [];
  }
  const found = await deps.resolveCompanies(company ?? query).catch(() => [] as Company[]);
  if (!found.length && company) return [{ name: company, aliases: [company.toLowerCase()] }];
  return found;
}

export function selectEngines(req: { engines?: string[]; categories?: Category[] }): Engine[] {
  if (req.engines?.length) {
    return req.engines.map((n) => ENGINE_BY_NAME.get(n)).filter((e): e is Engine => !!e);
  }
  const cats = req.categories?.length ? req.categories : ["general"];
  return ENGINES.filter((e) => !e.disabled && e.categories.some((c) => cats.includes(c)));
}

export async function metasearch(req: SearchRequest, deps: SearchDeps): Promise<SearchResponse> {
  const bangs = parseBangs(req.query);
  const params: SearchParams = { ...req, query: bangs.query };
  const categories = bangs.categories.length ? bangs.categories : req.categories;
  const engines = selectEngines({
    engines: bangs.engines.length ? bangs.engines : req.engines,
    categories,
  });
  const newsMode =
    (categories ?? []).some((c) => c === "news" || c === "filings") ||
    (engines.length > 0 && engines.every((e) => e.categories.some((c) => c === "news" || c === "filings")));
  // Resolve companies while the engines run (every mode: general web is filtered by company too).
  const companiesPromise = resolveFor(req.company, params.query, deps);

  const container = new ResultContainer(new Map(engines.map((e) => [e.name, e.weight ?? 1])));
  const unresponsive: UnresponsiveEngine[] = [];
  const timings: Timing[] = [];
  const outcomes: Outcome[] = [];
  const now = Date.now();

  const usable = engines.filter((engine) => {
    const state = deps.health[engine.name];
    if (state && state.suspendedUntil > now) {
      unresponsive.push({ engine: engine.name, error: state.reason, suspended: true });
      return false;
    }
    if (params.pageno > 1 && !engine.paging) return false;
    if (engine.maxPage && params.pageno > engine.maxPage) return false;
    if (params.timeRange && !engine.timeRangeSupport) return false;
    return true;
  });

  const runEngines = (list: Engine[]) =>
    Promise.all(
    list.map(async (engine) => {
      const started = Date.now();
      try {
        const { results, cached, skipped } = await runEngine(engine, params, deps.cache, deps.cacheVersion);
        if (skipped) return;
        container.extend(engine, results);
        timings.push({ engine: engine.name, ms: Date.now() - started, results: results.length, cached });
        if (!cached) outcomes.push({ engine: engine.name, ok: true });
      } catch (e) {
        const err = toEngineError(e);
        unresponsive.push({ engine: engine.name, error: `${err.kind}: ${err.message}`, suspended: false });
        timings.push({ engine: engine.name, ms: Date.now() - started, results: 0 });
        outcomes.push(outcomeFromError(engine.name, err));
      }
    }),
  );

  await runEngines(usable.filter((e) => !e.fallback));
  // Second phase: reserve engines run only when the first pass found too little about the company.
  const reserve = usable.filter((e) => e.fallback);
  if (reserve.length) {
    const companies = await companiesPromise;
    const terms = splitQuery(params.query);
    const relevant = container.ordered().filter((r) => isAbout(r, terms, companies)).length;
    if (relevant < FALLBACK_BELOW) await runEngines(reserve);
  }

  if (outcomes.length) deps.recordOutcomes(outcomes);

  let results = container.ordered();
  const response: SearchResponse = { query: params.query, results, unresponsiveEngines: unresponsive, timings };
  if (newsMode) {
    const companies = await companiesPromise;
    const dropped = { nonArticle: 0, spam: 0, offTopic: 0, outOfRange: 0 };
    results = refineNews(results, params.query, companies, dropped);
    if (req.verifyDates !== false && deps.publishedDate) await verifyDates(results, deps.publishedDate);
    results = rankByRecency(results);
    const before = results.length;
    results = withinTimeRange(results, params.timeRange);
    dropped.outOfRange = before - results.length;
    response.dropped = dropped;
    const topics = companies.length ? topicTerms(params.query, companies.flatMap((c) => c.aliases)) : [];
    if (topics.length) {
      const matched = results.filter((r) => termHits(`${r.title} ${r.content ?? ""} ${r.url.replace(/[-_/.]+/g, " ")}`, topics) > 0).length;
      response.topic = { terms: topics, matched };
    }
    if (companies.length) response.companies = describeCompanies(companies);
  } else {
    // General web: when the query names a company, keep only pages about it, without
    // login, app, portal or dictionary pages, and date what the engines left undated.
    const companies = await companiesPromise;
    if (companies.length) {
      const dropped = { nonArticle: 0, spam: 0, offTopic: 0, outOfRange: 0 };
      results = refineGeneral(results, params.query, companies, dropped);
      if (req.verifyDates !== false && deps.publishedDate) await verifyDates(results, deps.publishedDate);
      const before = results.length;
      results = withinTimeRange(results, params.timeRange);
      dropped.outOfRange = before - results.length;
      response.dropped = dropped;
      response.companies = describeCompanies(companies);
    } else {
      results = withinTimeRange(results, params.timeRange);
    }
  }
  if (req.docTypes?.length) {
    const wanted = new Set(req.docTypes);
    results = results.filter((r) => !r.docType || wanted.has(r.docType));
  }
  results = req.sort === "date" ? sortByDate(results) : results;
  // Data cards (index levels and returns) answer the question; keep them on top.
  response.results = [...results.filter(isDataCard), ...results.filter((r) => !isDataCard(r))];
  return response;
}

function describeCompanies(companies: Company[]): string[] {
  return companies.map((c) => {
    const ids = [c.nse && `NSE: ${c.nse}`, c.bse && `BSE: ${c.bse}`].filter(Boolean).join(", ");
    return ids ? `${c.name} (${ids})` : c.name;
  });
}

/** General-web results for a company query: about the company, and not junk pages. */
export function refineGeneral(
  results: MergedResult[],
  query: string,
  companies: CompanyLike[],
  dropped: { nonArticle: number; spam: number; offTopic: number },
): MergedResult[] {
  const terms = splitQuery(query);
  return results.filter((r) => {
    if (isDataCard(r)) return true;
    if (isJunkPage(r.url)) return dropped.nonArticle++, false;
    if (isSpam(r.title, r.content, query)) return dropped.spam++, false;
    if (!isAbout(r, terms, companies)) return dropped.offTopic++, false;
    return true;
  });
}

function isDataCard(r: MergedResult): boolean {
  return r.engines.includes("index data");
}

/** Drops non-articles, spam and results that aren't about the query's subject. */
export function refineNews(
  results: MergedResult[],
  query: string,
  companies: CompanyLike[],
  dropped: { nonArticle: number; spam: number; offTopic: number },
): MergedResult[] {
  const terms = splitQuery(query);
  const topics = companies.length ? topicTerms(query, companies.flatMap((c) => c.aliases)) : [];
  const onTopic = (r: MergedResult) => termHits(`${r.title} ${r.content ?? ""} ${r.url.replace(/[-_/.]+/g, " ")}`, topics) > 0;
  // Count only stories about the subject: other companies' deal stories don't make
  // Infosys's off-topic news droppable.
  const enoughOnTopic =
    topics.length > 0 &&
    results.filter((r) => onTopic(r) && !isNonArticle(r.url) && isAbout(r, terms, companies)).length >= TOPIC_DROP_MIN_MATCHES;
  return results.filter((r) => {
    // Index cards were picked by the index engine's own name matching.
    if (isDataCard(r)) return true;
    if (isNonArticle(r.url) || isJunkPage(r.url)) return dropped.nonArticle++, false;
    if (isSpam(r.title, r.content, query)) return dropped.spam++, false;
    if (!isAbout(r, terms, companies)) return dropped.offTopic++, false;
    // Named only in the snippet ("...rivals such as Hero MotoCorp..."): keep, but below
    // stories that carry the subject in the headline or URL.
    if (!isAbout({ url: r.url, title: r.title }, terms, companies)) r.score *= PASSING_MENTION_WEIGHT;
    if (topics.length && !onTopic(r)) {
      if (enoughOnTopic) return dropped.offTopic++, false;
      r.score *= TOPIC_MISS_WEIGHT;
    }
    return true;
  });
}

// Per-isolate memo of page-derived dates (null: page has none), so repeat
// searches don't refetch the same articles.
const pageDates = new Map<string, string | null>();
const PAGE_DATES_MAX = 5000;

/** Reads publish dates from page metadata for the top undated results. */
async function verifyDates(results: MergedResult[], lookup: (url: string) => Promise<string | undefined>) {
  const pending = results.filter((r) => !r.publishedDate).slice(0, DATE_CHECKS);
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const r = pending[next++];
      let date = pageDates.get(r.url);
      if (date === undefined) {
        date = (await lookup(r.url).catch(() => undefined)) ?? null;
        if (pageDates.size >= PAGE_DATES_MAX) pageDates.clear();
        pageDates.set(r.url, date);
      }
      if (date) r.publishedDate = date;
    }
  };
  await Promise.all(Array.from({ length: Math.min(DATE_CHECK_CONCURRENCY, pending.length) }, worker));
}

/**
 * News relevance decays with age: a story from today keeps its full score, one
 * from a month ago half. Undated results count as moderately old.
 */
export function rankByRecency(results: MergedResult[], now = Date.now()): MergedResult[] {
  const weighted = results.map((r, i) => {
    const t = r.publishedDate ? Date.parse(r.publishedDate) : NaN;
    const factor = Number.isNaN(t) ? 0.5 : 1 / (1 + Math.max(0, now - t) / (30 * DAY_MS));
    return { r, i, score: r.score * factor };
  });
  weighted.sort((a, b) => b.score - a.score || a.i - b.i);
  return weighted.map((w) => w.r);
}

/** Drops results dated before the time range (undated results are kept). */
export function withinTimeRange(results: MergedResult[], timeRange?: TimeRange, now = Date.now()): MergedResult[] {
  if (!timeRange) return results;
  const cutoff = now - TIME_RANGE_MS[timeRange] - RANGE_SLACK_MS;
  return results.filter((r) => {
    const t = r.publishedDate ? Date.parse(r.publishedDate) : NaN;
    return Number.isNaN(t) || t >= cutoff;
  });
}

/** Newest first; undated results keep their relative order after the dated ones. */
export function sortByDate(results: MergedResult[]): MergedResult[] {
  const time = (r: MergedResult) => (r.publishedDate ? Date.parse(r.publishedDate) : NaN);
  const dated = results.filter((r) => !Number.isNaN(time(r))).sort((a, b) => time(b) - time(a));
  return [...dated, ...results.filter((r) => Number.isNaN(time(r)))];
}

/** One engine round trip: request → fetch → error check → parse, with per-engine caching. */
export async function runEngine(
  engine: Engine,
  params: SearchParams,
  cache?: Cache,
  cacheVersion = "",
): Promise<{ results: EngineResult[]; cached: boolean; skipped?: boolean }> {
  const cacheKey = cache ? engineCacheKey(engine, params, cacheVersion) : undefined;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) return { results: await hit.json<EngineResult[]>(), cached: true };
  }

  const signal = AbortSignal.timeout(engine.timeout ?? DEFAULT_TIMEOUT_MS);
  const ctx: EngineContext = {
    fetch: (input, init) => fetch(input, { ...init, signal }),
    signal,
    memo,
  };
  let results: EngineResult[];
  if (engine.search) {
    results = await engine.search(params, ctx);
  } else {
    const req = await engine.request(params, ctx);
    if (!req) return { results: [], cached: false, skipped: true };
    const resp = await send(req, signal);
    if (engine.raiseForHttpError !== false) raiseForHttpError(resp);
    results = await engine.response(resp, params, ctx);
  }
  results = results.filter((r) => r.url && r.title);

  if (cache && cacheKey && results.length) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(results), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_TTL_SECONDS}` },
      }),
    );
  }
  return { results, cached: false };
}

function engineCacheKey(engine: Engine, p: SearchParams, version: string): string {
  const u = new URL(`https://searx-cache.internal/${encodeURIComponent(engine.name)}`);
  // The deployment's version: results cached by older code are never served after a deploy.
  if (version) u.searchParams.set("v", version);
  u.searchParams.set("q", p.query);
  u.searchParams.set("p", String(p.pageno));
  u.searchParams.set("l", p.language);
  u.searchParams.set("s", String(p.safesearch));
  if (p.timeRange) u.searchParams.set("t", p.timeRange);
  if (p.docTypes?.length) u.searchParams.set("d", [...p.docTypes].sort().join(","));
  return u.href;
}

function toEngineError(e: unknown): EngineError {
  if (e instanceof EngineError) return e;
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : String(e);
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/i.test(message)) {
    return new EngineError("timeout", "timed out");
  }
  if (e instanceof TypeError && /fetch|network|connect|dns/i.test(message)) return new EngineError("network", message);
  // workerd's opaque "internal error; reference = ..." is transient, not a parser bug.
  if (/internal error/i.test(message)) return new EngineError("network", message);
  // Anything else is most likely the engine's parser choking on a changed page.
  return new EngineError("parse", message);
}
