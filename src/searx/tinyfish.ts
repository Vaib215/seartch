// TinyFish web search (https://docs.tinyfish.ai). TinyFish's /search costs
// nothing per call, and three routes reach it:
//   - directly, with a TinyFish key (TINYFISH_API_KEYS)
//   - through the treg gateway (https://treg.to; TREG_API_KEYS), about 1.5 s
//   - through Monid (https://api.monid.ai; MONID_API_KEYS), about 4 s
// Each secret is a comma- or whitespace-separated key list. All keys form one
// pool: a search leases the fastest route that has room, and concurrent
// searches spill over to slower routes and other keys. A search that has not
// answered within HEDGE_AFTER_MS is also sent to the next key, and the first
// answer wins. Without keys every call returns no results.

import type { EngineResult, TimeRange } from "./types";
import { EngineError, EngineTooManyRequests } from "./types";

const TINYFISH_SEARCH = "https://api.search.tinyfish.ai/";
const TREG_CALL = "https://treg.to/call/";
const MONID_RUN = "https://api.monid.ai/v1/run";
const MONID_RUNS = "https://api.monid.ai/v1/runs/";
const POLL_INTERVAL_MS = 700;
const TERMINAL = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIME_OUT"]);
/** Typical treg latency is 1.3–2.4 s; slower calls are usually stuck (one took 77 s). */
const HEDGE_AFTER_MS = 2500;

export const RECENCY_MINUTES: Record<TimeRange, number> = {
  day: 1440,
  week: 10_080,
  month: 43_200,
  quarter: 131_040,
  year: 525_600,
};

export interface TinyfishOptions {
  domainType?: "web" | "news";
  includeDomains?: string[];
  excludeDomains?: string[];
  timeRange?: TimeRange;
  /** Ranking hint passed to TinyFish. */
  purpose?: string;
  location?: string;
  page?: number;
}

interface TinyfishItem {
  title?: string;
  url?: string;
  site_name?: string;
  publisher?: string;
  snippet?: string;
  date?: string;
}

interface MonidRun {
  runId?: string;
  status?: string;
  output?: { results?: TinyfishItem[] };
  message?: string;
  error?: { message?: string };
}

type Provider = "tinyfish" | "treg" | "monid";

interface PooledKey {
  provider: Provider;
  key: string;
  /** Searches currently using this key. */
  inUse: number;
  /** Epoch ms until which the key is resting after a 429. */
  coolUntil: number;
  /** Epoch ms of the key's last search, to spread per-minute limits across keys. */
  lastUsed: number;
}

const PROVIDERS: Provider[] = ["tinyfish", "treg", "monid"]; // fastest first
/** Searches one key takes at once before the pool spills to the next key. */
const CAPACITY: Record<Provider, number> = { tinyfish: 8, treg: 8, monid: 1 };
const COOLDOWN_MS = 60_000;
let pool: PooledKey[] = [];
let configured = "";

export type TinyfishKeys = Partial<Record<Provider, string>>;

export function configureTinyfish(keys: TinyfishKeys) {
  const signature = PROVIDERS.map((p) => keys[p] ?? "").join("|");
  if (signature === configured) return; // keep in-use counts across requests
  configured = signature;
  pool = PROVIDERS.flatMap((provider) =>
    [...new Set((keys[provider] ?? "").split(/[\s,]+/).filter(Boolean))].map((key) => ({ provider, key, inUse: 0, coolUntil: 0, lastUsed: 0 })),
  );
}

export function tinyfishConfigured(): boolean {
  return pool.length > 0;
}

/** How many TinyFish searches can run at once without overloading a key. */
export function tinyfishParallelism(): number {
  return pool.filter((k) => k.coolUntil <= Date.now()).reduce((n, k) => n + CAPACITY[k.provider], 0);
}

/**
 * Keys to try for one search, best first: keys with room before full ones,
 * then the faster route, then the fewest searches in flight, then the least
 * recently used, so searches rotate through a route's keys and no single key
 * reaches its per-minute limit early. Keys resting after a 429 come last.
 */
function candidates(): PooledKey[] {
  const now = Date.now();
  const full = (k: PooledKey) => Number(k.inUse >= CAPACITY[k.provider]);
  const rank = (k: PooledKey) => PROVIDERS.indexOf(k.provider);
  const rested = pool
    .filter((k) => k.coolUntil <= now)
    .sort((a, b) => full(a) - full(b) || rank(a) - rank(b) || a.inUse - b.inUse || a.lastUsed - b.lastUsed);
  const resting = pool.filter((k) => k.coolUntil > now).sort((a, b) => a.coolUntil - b.coolUntil);
  return [...rested, ...resting];
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const UNIT_MS: Record<string, number> = {
  minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
};

/**
 * TinyFish dates come as "20 Nov 2025", "Nov 20, 2025", ISO, or relative
 * ("3 months ago"); relative ones are approximate but still order results.
 */
export function parseTinyfishDate(raw: string | undefined, now = Date.now()): string | undefined {
  const s = raw?.trim().toLowerCase();
  if (!s) return undefined;
  const rel = /^(an?|\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/.exec(s);
  if (rel) {
    const n = rel[1] === "a" || rel[1] === "an" ? 1 : Number(rel[1]);
    return new Date(now - n * UNIT_MS[rel[2]]).toISOString();
  }
  if (s === "yesterday") return new Date(now - UNIT_MS.day).toISOString();
  let m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2]] !== undefined) return new Date(Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1]))).toISOString();
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1]] !== undefined) return new Date(Date.UTC(Number(m[3]), MONTHS[m[1]], Number(m[2]))).toISOString();
  const t = Date.parse(raw!);
  return Number.isNaN(t) || t > now + 2 * UNIT_MS.day ? undefined : new Date(t).toISOString();
}

export function mapTinyfishResults(items: TinyfishItem[]): EngineResult[] {
  return items
    .filter((r) => r.url && r.title)
    .map((r) => ({
      url: r.url!,
      title: r.title!.trim(),
      content: r.snippet?.trim() || undefined,
      publishedDate: parseTinyfishDate(r.date),
      author: r.publisher?.trim() || r.site_name?.replace(/^www\./, "") || undefined,
    }));
}

function searchParams(query: string, opts: TinyfishOptions): Record<string, string> {
  const params: Record<string, string> = {
    query,
    domain_type: opts.domainType ?? "web",
    language: "en",
    location: opts.location ?? "IN",
    purpose: opts.purpose ?? "Indian listed-company and market research",
  };
  if (opts.includeDomains?.length) params.include_domains = opts.includeDomains.join(",");
  if (opts.excludeDomains?.length) params.exclude_domains = opts.excludeDomains.join(",");
  if (opts.timeRange) params.recency_minutes = String(RECENCY_MINUTES[opts.timeRange]);
  if (opts.page) params.page = String(opts.page);
  return params;
}

/** A failed attempt on one key; the search moves on to the next key. */
class KeyFailed extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** One search on one key. */
async function attempt(slot: PooledKey, params: Record<string, string>, signal: AbortSignal): Promise<EngineResult[]> {
  slot.inUse++;
  slot.lastUsed = Date.now();
  try {
    const res = await send(slot, params, signal);
    if (!res.ok) {
      await res.body?.cancel();
      // This key is at its limit: rest it.
      if (res.status === 429) slot.coolUntil = Date.now() + COOLDOWN_MS;
      throw new KeyFailed(res.status, `${slot.provider} HTTP ${res.status}`);
    }
    if (slot.provider !== "monid") return mapTinyfishResults((await res.json<{ results?: TinyfishItem[] }>()).results ?? []);
    let run = await res.json<MonidRun>();
    while (run.status && !TERMINAL.has(run.status) && run.runId) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll = await fetch(`${MONID_RUNS}${encodeURIComponent(run.runId)}`, {
        headers: { authorization: `Bearer ${slot.key}` },
        signal,
      });
      run = await poll.json<MonidRun>();
    }
    if (run.status !== "COMPLETED") {
      throw new KeyFailed(0, `TinyFish run ${run.status ?? "unknown"}: ${run.error?.message ?? run.message ?? ""}`.trim());
    }
    return mapTinyfishResults(run.output?.results ?? []);
  } finally {
    slot.inUse--;
  }
}

function send(slot: PooledKey, params: Record<string, string>, signal: AbortSignal): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  switch (slot.provider) {
    case "tinyfish":
      return fetch(`${TINYFISH_SEARCH}?${qs}`, { headers: { "x-api-key": slot.key }, signal });
    case "treg": {
      // treg lists news as its own endpoint; a zero cost cap refuses any route that would bill.
      const endpoint = params.domain_type === "news" ? "tinyfish.web.search.news" : "tinyfish.web.search";
      return fetch(`${TREG_CALL}${endpoint}?${qs}`, {
        headers: { "x-treg-token": slot.key, "x-treg-route-max-cost": "0" },
        signal,
      });
    }
    case "monid": {
      const { domain_type, ...rest } = params;
      const queryParams = {
        ...rest,
        ...(domain_type !== "web" ? { domain_type } : {}),
        ...(rest.recency_minutes ? { recency_minutes: Number(rest.recency_minutes) } : {}),
        ...(rest.page ? { page: Number(rest.page) } : {}),
      };
      return fetch(MONID_RUN, {
        method: "POST",
        headers: { authorization: `Bearer ${slot.key}`, "content-type": "application/json" },
        body: JSON.stringify({ provider: "tinyfish", endpoint: "/search", input: { queryParams } }),
        signal,
      });
    }
  }
}

/**
 * One TinyFish search. Throws EngineError on failure so engines using it get
 * the usual suspension and reporting; returns [] when no keys are configured.
 */
export async function tinyfishSearch(query: string, opts: TinyfishOptions, signal: AbortSignal): Promise<EngineResult[]> {
  if (!pool.length) return [];
  const params = searchParams(query, opts);
  const order = candidates();
  const ctrl = new AbortController();
  const stop = () => ctrl.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const failures: KeyFailed[] = [];
  let hedge: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<EngineResult[]>((resolve, reject) => {
      let next = 0;
      let running = 0;
      const launch = () => {
        clearTimeout(hedge);
        if (next >= order.length) {
          if (!running) reject(exhausted(failures));
          return;
        }
        running++;
        attempt(order[next++], params, ctrl.signal).then(resolve, (e) => {
          running--;
          if (ctrl.signal.aborted) return reject(e);
          failures.push(e instanceof KeyFailed ? e : new KeyFailed(0, String(e)));
          launch();
        });
        hedge = setTimeout(launch, HEDGE_AFTER_MS);
      };
      launch();
    });
  } finally {
    clearTimeout(hedge);
    ctrl.abort(); // cancel the slower attempt
    signal.removeEventListener("abort", stop);
  }
}

function exhausted(failures: KeyFailed[]): Error {
  if (failures.length && failures.every((f) => f.status === 429)) return new EngineTooManyRequests("all TinyFish keys rate limited");
  return new EngineError("http", `all TinyFish keys failed (${failures.map((f) => f.message).join("; ")})`);
}
