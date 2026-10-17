// Resolves the company a query is about (name, NSE ticker, BSE code) using an
// external fuzzy ticker-search service, so news can be matched on every name
// the company goes by and filings can be fetched by ticker.
//
// The service is optional and configured per deployment: a service binding
// (TICKER_SEARCH) or a URL (TICKER_SEARCH_URL). It must answer
//   POST <base>/api/stock/fuzzy {"query": "...", "limit": n}
//   → { data: [{ nseTicker, bseTicker, companyName, isinNumber, marketCap, matchType, confidence }] }
//   POST <base>/api/stock/fuzzy/batch {"queries": ["...", ...]}
//   → { data: [{ query, match: { ...same fields } | null }] }
// Without it, nothing resolves and news relevance falls back to the query words.

import { INDEX_WORDS, splitQuery } from "./terms";

export interface Company {
  name: string;
  /** NSE symbol, e.g. "TATAELXSI". */
  nse?: string;
  /** BSE scrip code, e.g. "500408". */
  bse?: string;
  isin?: string;
  /** Lowercase phrases that identify the company in text: names, tickers, the user's own wording. */
  aliases: string[];
}

export interface FuzzyMatch {
  nseTicker?: string;
  bseTicker?: string;
  companyName: string;
  isinNumber?: string;
  marketCap?: number;
  matchType: string;
  confidence: number;
}

export type TickerLookup = (query: string, limit: number) => Promise<FuzzyMatch[]>;
/** The best match for each query, in order; undefined where nothing matched. */
export type TickerBatchLookup = (queries: string[]) => Promise<(FuzzyMatch | undefined)[]>;

let lookup: TickerLookup | undefined;
let batchLookup: TickerBatchLookup | undefined;

/** Called per request with the deployment's ticker service (or undefined to disable). */
export function configureTickerSearch(fn: TickerLookup | undefined, batch?: TickerBatchLookup) {
  lookup = fn;
  batchLookup = fn && batch;
}

export function tickerSearchConfigured(): boolean {
  return lookup !== undefined;
}

/** A TickerLookup over HTTP: `call(path, body)` is a service binding or a plain fetch. */
export function httpTickerLookup(call: (path: string, body: string) => Promise<Response>): TickerLookup {
  return async (query, limit) => {
    const res = await call("/api/stock/fuzzy", JSON.stringify({ query, limit }));
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`ticker search: HTTP ${res.status}`);
    }
    const body = await res.json<{ data?: FuzzyMatch[] }>();
    return body.data ?? [];
  };
}

export function httpTickerBatch(call: (path: string, body: string) => Promise<Response>): TickerBatchLookup {
  return async (queries) => {
    const res = await call("/api/stock/fuzzy/batch", JSON.stringify({ queries }));
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`ticker batch: HTTP ${res.status}`);
    }
    const body = await res.json<{ data?: { query: string; match?: FuzzyMatch | null }[] }>();
    const byQuery = new Map((body.data ?? []).map((d) => [d.query, d.match ?? undefined]));
    return queries.map((q) => byQuery.get(q));
  };
}

// Abbreviations the fuzzy service resolves to the wrong company on its own.
const ABBREVIATIONS: Record<string, string> = {
  ril: "reliance industries",
  hul: "hindustan unilever",
  // Post-merger, "HDFC" in market news means HDFC Bank.
  hdfc: "hdfc bank",
};

// Names that articles use but the listing doesn't contain, keyed by NSE symbol.
const EXTRA_ALIASES: Record<string, string[]> = {
  RELIANCE: ["ril", "reliance"],
  HINDUNILVR: ["hul"],
  LT: ["l&t", "larsen"],
  SBIN: ["sbi"],
  BHARTIARTL: ["airtel"],
  "M&M": ["mahindra"],
  KOTAKBANK: ["kotak"],
  LICI: ["lic"],
  ETERNAL: ["zomato"],
  POLICYBZR: ["policybazaar", "pb fintech"],
  PAYTM: ["paytm"],
  NYKAA: ["nykaa"],
  DMART: ["dmart"],
  INDIGO: ["indigo"],
  INFY: ["infosys"],
  HCLTECH: ["hcl tech", "hcltech"],
  EICHERMOT: ["eicher", "royal enfield"],
  IOC: ["indian oil", "iocl"],
  ULTRACEMCO: ["ultratech"],
  NESTLEIND: ["nestle"],
  JIOFIN: ["jio financial"],
};

// Listing noise: rights entitlements, partly-paid lines and funds share names with the company.
const NOT_A_COMPANY = /rights entitlement|partly paid|\betf\b|\bfund\b|\bfof\b|\bbees\b/i;
const MIN_FUZZY_CONFIDENCE = 0.8;
// A prefix match ("hdfc" → HDFCBANK) counts only when one company clearly dominates
// the alternatives; "tata" matches several large companies and resolves to none.
const PREFIX_DOMINANCE = 3;

/** Picks the company a phrase names from the service's candidates, or undefined. */
export function pickMatch(candidates: FuzzyMatch[]): FuzzyMatch | undefined {
  const live = candidates.filter((m) => (m.marketCap ?? 0) > 0 && !NOT_A_COMPANY.test(m.companyName));
  if (!live.length) return undefined;
  const best = Math.max(...live.map((m) => m.confidence));
  const top = live
    .filter((m) => m.confidence >= best - 0.02)
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  const pick = top[0];
  if (pick.matchType.startsWith("exact")) return pick;
  if (pick.matchType.includes("prefix")) {
    const runnerUp = top[1]?.marketCap ?? 0;
    return (pick.marketCap ?? 0) >= PREFIX_DOMINANCE * runnerUp ? pick : undefined;
  }
  return pick.confidence >= MIN_FUZZY_CONFIDENCE ? pick : undefined;
}

/** "Tata Elxsi Ltd." → "tata elxsi"; "Dr. Reddy's Laboratories Ltd" → "dr reddy's laboratories". */
export function coreName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(india\)/g, " ")
    .replace(/\b(limited|ltd)\b\.?/g, " ")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC = new Set(["of", "the", "and", "&", "co", "company", "corporation", "india", "industries", "bank"]);

export function aliasesFor(m: FuzzyMatch, phrase: string): string[] {
  const core = coreName(m.companyName);
  const words = core.split(" ");
  const aliases = new Set<string>([core]);
  // Articles shorten long names: "Tata Consultancy Services" → "Tata Consultancy".
  if (words.length >= 3 && !GENERIC.has(words[0]) && !GENERIC.has(words[1])) aliases.add(`${words[0]} ${words[1]}`);
  if (m.nseTicker && !/^\d+$/.test(m.nseTicker)) aliases.add(m.nseTicker.toLowerCase());
  if (m.bseTicker) aliases.add(m.bseTicker);
  for (const a of EXTRA_ALIASES[m.nseTicker ?? ""] ?? []) aliases.add(a);
  // The user's own wording ("zomato", "indigo"), when it is short enough to be a name
  // rather than a name plus a topic ("infosys deal wins").
  if (phrase.length >= 2 && phrase.split(" ").length <= 2) aliases.add(phrase);
  return [...new Set([...aliases].map(matchKey))].filter((a) => a.length >= 2);
}

function toCompany(m: FuzzyMatch, phrase: string): Company {
  return {
    name: m.companyName,
    nse: m.nseTicker && !/^\d+$/.test(m.nseTicker) ? m.nseTicker : undefined,
    bse: m.bseTicker || undefined,
    isin: m.isinNumber,
    aliases: aliasesFor(m, phrase),
  };
}

// Sector and commodity words that name markets, not companies ("gold price today",
// "pharma stocks"); as a whole phrase they never resolve.
const GENERIC_PHRASES = new Set([
  "gold", "silver", "oil", "crude", "steel", "power", "energy", "bank", "banks", "banking", "pharma", "auto", "metal",
  "metals", "it", "fmcg", "realty", "media", "infra", "cement", "sugar", "textile", "textiles", "psu", "defence",
  "railway", "railways", "ipo", "ipos", "market", "markets", "stock market", "share market", "rupee", "bond", "bonds",
  "inflation", "gdp", "budget", "tax", "gst", "fii", "dii", "fpi", "mutual fund", "mutual funds", "sip", "crypto",
]);

/** Subject phrases per compared company: "TCS vs Infosys Q2" → ["tcs", "infosys"]. */
export function subjectPhrases(query: string): string[] {
  const parts = query.split(/\s+(?:vs\.?|versus|compared (?:to|with)|against)\s+|\s*[,;]\s*/i);
  const phrases: string[] = [];
  for (const part of parts) {
    // "Nifty 50 one year return" is about an index, not a listed company.
    if (INDEX_WORDS.test(part)) continue;
    let phrase = splitQuery(part).subject.join(" ");
    phrase = ABBREVIATIONS[phrase] ?? phrase;
    if (GENERIC_PHRASES.has(phrase)) continue;
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases.slice(0, 3);
}

// Per-isolate memo: the same query is resolved by the relevance filter and by
// the filings and feed engines within one search.
const memo = new Map<string, { at: number; companies: Promise<Company[]> }>();
const MEMO_TTL_MS = 30 * 60_000;
const MEMO_MAX = 2000;

/** The companies a query is about (at most 3), or [] if none or no ticker service. */
export function resolveCompanies(query: string): Promise<Company[]> {
  const search = lookup;
  if (!search) return Promise.resolve([]);
  const key = query.trim().toLowerCase();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.companies;
  const companies = resolve(query, search, batchLookup).catch(() => []);
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, { at: Date.now(), companies });
  return companies;
}

// Single words that exactly match a ticker or listed name but in a query are
// usually ordinary words ("investment idea", "solar stocks"); they never name
// the company inside a longer phrase.
const COMMON_TICKER_WORDS = new Set([
  "solar", "energy", "power", "idea", "star", "oil", "max", "focus", "vision", "prime", "sun", "apex", "route", "page",
  "rain", "trust", "future", "global", "international", "infra", "bank", "retail", "tea", "electric", "cloud", "dollar",
  "standard", "hotels", "sip", "hdfc",
]);
// Rating agencies, brokerages and exchanges are listed companies too, but in a
// query they are usually the source ("CRISIL rating for Polycab"), so another
// company in the same query wins over them.
const SOURCE_WORDS = new Set([
  "bse", "nse", "crisil", "icra", "care", "acuite", "infomerics", "brickwork", "nuvama", "emkay", "motilal", "oswal",
  "kotak", "icici", "axis", "jm", "sharekhan", "angel", "anand", "rathi", "ndtv", "zee",
]);
const MAX_SPAN_WORDS = 5;
const MAX_PHRASE_WORDS = 12;
const MAX_SPAN_CHARS = 60;

/** Contiguous word spans that could name a company: "genus power infra order" → "genus power", "power infra", ... */
export function companySpans(phrase: string): string[] {
  const words = phrase.split(" ").slice(0, MAX_PHRASE_WORDS);
  const spans: string[] = [];
  for (let n = Math.min(MAX_SPAN_WORDS, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const span = words.slice(i, i + n).join(" ");
      if (span.length < 2 || span.length > MAX_SPAN_CHARS || GENERIC_PHRASES.has(span)) continue;
      if (n === 1 && (COMMON_TICKER_WORDS.has(span) || (/^\d+$/.test(span) && span.length !== 6))) continue;
      if (!spans.includes(span)) spans.push(span);
    }
  }
  return spans;
}

/**
 * The company a long phrase names somewhere inside it, from one batch lookup
 * of all its spans: only exact name or ticker matches count, preferring
 * spans without a source word, then the longest, then exact names, then the
 * earliest.
 */
async function spanMatch(phrase: string, batch: TickerBatchLookup): Promise<Company | undefined> {
  const spans = companySpans(phrase);
  if (!spans.length) return undefined;
  const matches = await batch(spans);
  const hits = spans
    .map((span, i) => ({ span, m: matches[i], at: phrase.indexOf(span) }))
    .filter(
      (h): h is { span: string; m: FuzzyMatch; at: number } =>
        !!h.m && h.m.matchType.startsWith("exact") && (h.m.marketCap ?? 0) > 0 && !NOT_A_COMPANY.test(h.m.companyName),
    );
  const score = (h: { span: string; m: FuzzyMatch; at: number }) => [
    Number(h.span.split(" ").some((w) => SOURCE_WORDS.has(w))),
    -h.span.split(" ").length,
    Number(h.m.matchType !== "exact_name"),
    h.at,
  ];
  hits.sort((a, b) => {
    const [x, y] = [score(a), score(b)];
    const i = x.findIndex((v, k) => v !== y[k]);
    return i < 0 ? 0 : x[i] - y[i];
  });
  return hits[0] && toCompany(hits[0].m, hits[0].span);
}

async function resolve(query: string, search: TickerLookup, batch?: TickerBatchLookup): Promise<Company[]> {
  const found = await Promise.all(
    subjectPhrases(query).map(async (phrase) => {
      const words = phrase.split(" ");
      // "genus power infrastructures smart meter order book": find the name anywhere in it.
      if (batch && words.length >= 2) {
        const company = await spanMatch(phrase, batch).catch(() => undefined);
        if (company) return company;
      }
      // "infosys deal wins" may not match as a whole; fall back to its leading words.
      for (let n = words.length; n >= 1 && n > words.length - 3; n--) {
        const attempt = words.slice(0, n).join(" ");
        if (GENERIC_PHRASES.has(attempt)) continue;
        const m = pickMatch(await search(attempt, 5));
        if (m) return toCompany(m, attempt);
      }
      return undefined;
    }),
  );
  const seen = new Set<string>();
  return found.filter((c): c is Company => {
    if (!c) return false;
    const id = c.isin ?? c.name;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Normalises text and aliases alike: lowercase, no dots or apostrophes. */
export function matchKey(s: string): string {
  return s.toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ");
}

export function _clearCompanyMemo() {
  memo.clear();
}
