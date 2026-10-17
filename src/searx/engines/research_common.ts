// Shared plumbing for the research engines (credit ratings, ValuePickr, analysis):
// a per-search time budget, a two-level cache, rated-entity name matching and
// the loose date formats rating agencies and forums use.

import { decodeEntities } from "../../util";
import { type Company, coreName } from "../companies";
import { CHROME_UA } from "../http";
import { EngineAccessDenied, EngineError, EngineTooManyRequests, type EngineContext } from "../types";

// --- time budget -----------------------------------------------------------------

let budgetOverrideMs: number | undefined;

/** For tests: a shorter budget for every search (undefined restores the engines' own). */
export function _setResearchBudget(ms?: number) {
  budgetOverrideMs = ms;
}

/**
 * A search's time budget. Each source is raced against it, so a site that stalls
 * (several of them do, for seconds at a time) costs only its own results.
 */
export class Budget {
  private constructor(private readonly deadline: number) {}

  static start(ms: number): Budget {
    return new Budget(Date.now() + (budgetOverrideMs ?? ms));
  }

  left(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  /** Rejects with a timeout EngineError once the budget is spent. */
  race<T>(p: Promise<T>, label: string): Promise<T> {
    const ms = this.left();
    if (ms <= 0) return Promise.reject(new EngineError("timeout", `${label}: out of time`));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EngineError("timeout", `${label}: timed out`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  /** An abort signal for fetches outside ctx.fetch (TinyFish): the budget or the engine's own timeout. */
  signal(parent?: AbortSignal): AbortSignal {
    const own = AbortSignal.timeout(Math.max(1, this.left()));
    return parent ? AbortSignal.any([parent, own]) : own;
  }
}

// --- HTTP ---------------------------------------------------------------------------

export const BROWSER = { "user-agent": CHROME_UA, "accept-language": "en-US,en;q=0.9" };

/** Throws the EngineError matching a failed response (after releasing its body). */
export async function checkResponse(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  await res.body?.cancel();
  if (res.status === 401 || res.status === 403) throw new EngineAccessDenied(`${label}: HTTP ${res.status}`);
  if (res.status === 429) throw new EngineTooManyRequests(`${label}: rate limited`);
  throw new EngineError("http", `${label}: HTTP ${res.status}`);
}

export async function getText(ctx: EngineContext, url: string, label: string, init: RequestInit = {}): Promise<string> {
  const res = await ctx.fetch(url, { ...init, headers: { ...BROWSER, ...(init.headers as Record<string, string>) } });
  await checkResponse(res, label);
  return res.text();
}

export async function getJson<T>(ctx: EngineContext, url: string, label: string, init: RequestInit = {}): Promise<T> {
  const text = await getText(ctx, url, label, { ...init, headers: { accept: "application/json", ...(init.headers as Record<string, string>) } });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EngineError("parse", `${label}: response is not JSON`);
  }
}

// --- cache ---------------------------------------------------------------------------

// Bump to drop everything cached by older parsers.
const CACHE_VERSION = "r5";
const MEMO_MAX = 500;
const memo = new Map<string, { expires: number; value: unknown }>();
let cacheApi = true;

function cacheUrl(key: string): string {
  return `https://seartch.internal/research/${CACHE_VERSION}/${key}`;
}

/** Per-isolate memo first, then the data center's Cache API. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const hit = memo.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  if (!cacheApi) return undefined;
  try {
    const res = await caches.default.match(cacheUrl(key));
    if (!res) return undefined;
    const ttl = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 60);
    const value = await res.json<T>();
    remember(key, value, Math.min(ttl, 600));
    return value;
  } catch {
    return undefined; // no Cache API here (tests, previews)
  }
}

export async function cachePut(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  remember(key, value, ttlSeconds);
  if (!cacheApi) return;
  try {
    await caches.default.put(
      cacheUrl(key),
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` } }),
    );
  } catch {
    // Caching is best-effort.
  }
}

function remember(key: string, value: unknown, ttlSeconds: number) {
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, { expires: Date.now() + ttlSeconds * 1000, value });
}

/** For tests: forget the memo and (optionally) stop using the Cache API. */
export function _resetResearchCache(useCacheApi = false) {
  memo.clear();
  cacheApi = useCacheApi;
}

/** A stable cache key part for a company. */
export function companyKey(c: Company): string {
  return encodeURIComponent((c.isin ?? c.nse ?? c.bse ?? c.name).toLowerCase());
}

// --- rated-entity names --------------------------------------------------------------

// Words that don't tell two entities apart ("Tata Power Co. Ltd." = "The Tata Power Company Limited").
const GENERIC = new Set(["limited", "ltd", "private", "pvt", "the", "company", "co", "corporation", "corp", "corpn", "and", "of", "llp", "inc", "plc"]);
// Abbreviations listings and agencies use for the same word.
const ABBREVIATIONS: Record<string, string> = {
  infra: "infrastructure",
  tech: "technology",
  techno: "technology",
  inds: "industry",
  intl: "international",
  engg: "engineering",
  mfg: "manufacturing",
  fin: "finance",
  pharma: "pharmaceutical",
  pharmaceuticals: "pharmaceutical",
  chem: "chemical",
  svcs: "service",
  hsg: "housing",
  mgmt: "management",
  invest: "investment",
};

function singular(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** The words that identify an entity: "The Tata Power Company Limited" → ["tata", "power"]. */
export function entityTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)?/g, " ") // "(Formerly ...)", "(India)"
    .replace(/&/g, " and ")
    .replace(/[.'’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => singular(ABBREVIATIONS[t] ?? t))
    .filter((t) => !GENERIC.has(t));
}

function tokensMatch(entity: string[], listed: string[], truncated: boolean): boolean {
  if (!entity.length || !listed.length) return false;
  const e = new Set(entity);
  const l = new Set(listed);
  const missing = [...l].filter((t) => !e.has(t)).length;
  const extra = [...e].filter((t) => !l.has(t)).length;
  if (!missing && !extra) return true;
  // "Genus Power Infrastructures ..." cut short in a search title.
  if (truncated && !extra && e.size >= 2) return true;
  // One word apart in a long name ("Apollo Hospitals Enterprise" vs "... Enterprises Ltd").
  return e.size >= 3 && l.size >= 3 && missing + extra <= 1;
}

/**
 * Whether an agency's entity name is the listed company itself, not a subsidiary,
 * SPV or namesake ("Genus Power Infrastructures Ltd" yes; "Genus Mewar Smart
 * Metering SPV" or "Tata Power Renewable Energy" for Tata Power, no).
 */
export function sameEntity(entity: string, company: Company): boolean {
  const truncated = /(\.\.\.|…)\s*$/.test(entity);
  const e = entityTokens(entity.replace(/(\.\.\.|…)\s*$/, ""));
  const candidates = [company.name, ...company.aliases.filter((a) => /[a-z]{3}/.test(a) && a.includes(" "))];
  return candidates.some((name) => tokensMatch(e, entityTokens(name), truncated));
}

/**
 * How articles usually name a company: "Genus Power" for "Genus Power
 * Infrastructures Ltd.", "Tata Consultancy" for TCS's listing name; short names whole.
 */
export function commonName(c: Company): string {
  const words = coreName(c.name).split(" ").filter(Boolean);
  const plain = (w: string) => /^[a-z0-9]+$/.test(w) && !GENERIC.has(w);
  const name = words.length >= 3 && plain(words[0]) && plain(words[1]) ? words.slice(0, 2) : words;
  return tidyName(name.join(" ").toUpperCase());
}

/** "TATA STEEL LIMITED" → "Tata Steel Limited"; mixed-case names are kept. */
export function tidyName(name: string): string {
  const s = name.replace(/\s+/g, " ").trim();
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(&/-])([a-z])/g, (_, pre: string, ch: string) => pre + ch.toUpperCase());
}

// --- text and dates --------------------------------------------------------------------

/** Visible text of an HTML fragment, without scripts, styles or comments. */
export function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts text to about `max` characters at a word boundary. */
export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FUTURE_SLACK_MS = 2 * 86_400_000;

function utcDay(y: number, m: number, d: number): number | undefined {
  if (y < 100) y += 2000;
  if (m < 0 || m > 11 || d < 1 || d > 31 || y < 1990) return undefined;
  const t = Date.UTC(y, m, d);
  return t > Date.now() + FUTURE_SLACK_MS ? undefined : t;
}

/**
 * Agency and forum date formats, as the calendar day (UTC midnight): "Apr 30, 2026",
 * "05 Dec 2024", "19th Mar 26", "November 20, 2025", "2026-07-08 00:00:00.000".
 */
export function parseDay(raw: string | undefined): number | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3})[a-z]*\.?,?[\s-]+(\d{4}|\d{2})\b/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return utcDay(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) return utcDay(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
  return undefined;
}

const DATE_IN_TEXT = /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/i;

/** The first full date written in a snippet ("... November 20, 2025 | Mumbai ..."). */
export function dateInText(text: string | undefined): number | undefined {
  const m = DATE_IN_TEXT.exec(text ?? "");
  return m ? parseDay(m[0]) : undefined;
}

/** "Nov 2025" */
export function monthYear(t: number): string {
  const d = new Date(t);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "19 Sep 2026" */
export function dayMonthYear(t: number): string {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Path words of a URL, with CamelCase file names split: ".../GenusPowerInfrastructuresLimited_Nov..." → "Genus Power ...". */
export function urlWords(url: string): string {
  let path = url;
  try {
    const u = new URL(url);
    path = decodeURIComponent(`${u.pathname} ${u.search}`);
  } catch {
    // keep the raw string
  }
  return path
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_/.%=?&+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
