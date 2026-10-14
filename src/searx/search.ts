// Port of searx/search/__init__.py + processors/online.py: pick engines, run
// them in parallel under a time budget, merge, and record engine health.

import { ENGINES, ENGINE_BY_NAME, ENGINE_BY_SHORTCUT } from "./engines";
import type { EngineState, Outcome } from "./health";
import { outcomeFromError } from "./health";
import { raiseForHttpError, send } from "./http";
import { type MergedResult, ResultContainer } from "./results";
import {
  type Category,
  type Engine,
  type EngineContext,
  type EngineResult,
  type SearchParams,
  EngineError,
} from "./types";

export const CATEGORIES: Category[] = ["general", "it", "science", "news", "packages", "repos", "q&a"];

const DEFAULT_TIMEOUT_MS = 3000;
const CACHE_TTL_SECONDS = 1800;

export interface SearchRequest extends SearchParams {
  /** Explicit engine names. Overrides categories. Disabled engines run when named. */
  engines?: string[];
  categories?: Category[];
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
}

export interface SearchDeps {
  /** Current engine suspension state for this data center. */
  health: Record<string, EngineState>;
  /** Persists outcomes (fire-and-forget). */
  recordOutcomes(outcomes: Outcome[]): void;
  cache?: Cache;
}

// Survives across requests within one isolate, like SearXNG's module globals.
const memo: EngineContext["memo"] = new Map();

/**
 * SearXNG's bang syntax (searx/query.py, simplified): `!gh foo` selects the
 * engine with shortcut/name "gh"; `!it foo` selects a category.
 */
export function parseBangs(query: string): { query: string; engines: string[]; categories: Category[] } {
  const engines: string[] = [];
  const categories: Category[] = [];
  const rest: string[] = [];
  for (const word of query.split(/\s+/).filter(Boolean)) {
    const bang = word.startsWith("!") && word.length > 1 ? word.slice(1).toLowerCase().replace(/_/g, " ") : undefined;
    const engine = bang ? (ENGINE_BY_SHORTCUT.get(bang) ?? ENGINE_BY_NAME.get(bang)) : undefined;
    if (engine) engines.push(engine.name);
    else if (bang && (CATEGORIES as string[]).includes(bang)) categories.push(bang as Category);
    else rest.push(word);
  }
  return { query: rest.join(" "), engines, categories };
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
  const engines = selectEngines({
    engines: bangs.engines.length ? bangs.engines : req.engines,
    categories: bangs.categories.length ? bangs.categories : req.categories,
  });

  const container = new ResultContainer(new Map(engines.map((e) => [e.name, e.weight ?? 1])));
  const unresponsive: UnresponsiveEngine[] = [];
  const timings: Timing[] = [];
  const outcomes: Outcome[] = [];
  const now = Date.now();

  const runnable = engines.filter((engine) => {
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

  await Promise.all(
    runnable.map(async (engine) => {
      const started = Date.now();
      try {
        const { results, cached, skipped } = await runEngine(engine, params, deps.cache);
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

  if (outcomes.length) deps.recordOutcomes(outcomes);
  return { query: params.query, results: container.ordered(), unresponsiveEngines: unresponsive, timings };
}

/** One engine round trip: request → fetch → error check → parse, with per-engine caching. */
export async function runEngine(
  engine: Engine,
  params: SearchParams,
  cache?: Cache,
): Promise<{ results: EngineResult[]; cached: boolean; skipped?: boolean }> {
  const cacheKey = cache ? engineCacheKey(engine, params) : undefined;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) return { results: await hit.json<EngineResult[]>(), cached: true };
  }

  const signal = AbortSignal.timeout(engine.timeout ?? DEFAULT_TIMEOUT_MS);
  const ctx: EngineContext = {
    fetch: (input, init) => fetch(input, { ...init, signal }),
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

function engineCacheKey(engine: Engine, p: SearchParams): string {
  const u = new URL(`https://searx-cache.internal/${encodeURIComponent(engine.name)}`);
  u.searchParams.set("q", p.query);
  u.searchParams.set("p", String(p.pageno));
  u.searchParams.set("l", p.language);
  u.searchParams.set("s", String(p.safesearch));
  if (p.timeRange) u.searchParams.set("t", p.timeRange);
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
