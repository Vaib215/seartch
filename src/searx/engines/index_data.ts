// Index data for queries that name an NSE index ("Nifty 50 one year return",
// "Bank Nifty today", "India VIX"): one result card per index with the level,
// day change, 1-week/1-month/1-year price returns, 52-week range and valuation,
// from NSE's live index API. Sensex (BSE) is not available: BSE blocks Workers.

import { CHROME_UA } from "../http";
import { type Engine, type EngineContext, type EngineResult, type SearchParams, EngineError } from "../types";
import { parseIst } from "./exchange_filings";

const ALL_INDICES = "https://www.nseindia.com/api/allIndices";
const TTL_MS = 60_000;
const MAX_CARDS = 3;

export interface NseIndex {
  index: string;
  last: number;
  variation?: number;
  percentChange?: number;
  yearHigh?: number;
  yearLow?: number;
  pe?: string;
  pb?: string;
  dy?: string;
  advances?: string;
  declines?: string;
  perChange365d?: number;
  perChange30d?: number;
  date365dAgo?: string;
  date30dAgo?: string;
  oneWeekAgo?: string;
  oneWeekAgoVal?: number;
  oneMonthAgoVal?: number;
  oneYearAgoVal?: number;
}

interface AllIndices {
  timestamp?: string;
  data?: NseIndex[];
}

// Market shorthand → NSE index name.
const NICKNAMES: [RegExp, string][] = [
  [/\bbank\s*nifty\b/i, "NIFTY BANK"],
  [/\bfin\s*nifty\b/i, "NIFTY FINANCIAL SERVICES"],
  [/\bmidcap\s*nifty\b|\bmidcpnifty\b/i, "NIFTY MIDCAP SELECT"],
  [/\bjunior\s*nifty\b/i, "NIFTY NEXT 50"],
  [/\b(india\s*)?vix\b/i, "INDIA VIX"],
];

function normalize(s: string): string {
  return ` ${s
    .toLowerCase()
    .replace(/\bnifty(\d)/g, "nifty $1")
    .replace(/\bindex\b|\bindices\b/g, " ")
    .replace(/[^\p{L}\p{N}&:/]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** NSE index names a query asks about, most specific first (at most three). */
export function matchIndices(query: string, names: string[]): string[] {
  const q = normalize(query);
  const found = new Map<string, number>();
  for (const [re, name] of NICKNAMES) if (re.test(query) && names.includes(name)) found.set(name, 99);
  for (const name of names) {
    const full = normalize(name).trim();
    // Phrase match, so "is it a good time to buy nifty" doesn't hit NIFTY IT.
    if (q.includes(` ${full} `)) found.set(name, Math.max(found.get(name) ?? 0, full.split(" ").length));
    const bare = full.replace(/^nifty /, "");
    if (bare !== full && bare.split(" ").length >= 2 && q.includes(` ${bare} `)) {
      found.set(name, Math.max(found.get(name) ?? 0, bare.split(" ").length));
    }
  }
  // Plain "nifty" means NIFTY 50.
  if (!found.size && / nifty /.test(q) && names.includes("NIFTY 50")) found.set("NIFTY 50", 1);
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .filter((name, i, all) => !all.slice(0, i).some((longer) => longer.startsWith(`${name} `)))
    .slice(0, MAX_CARDS);
}

let cache: { at: number; data: AllIndices } | undefined;

async function loadIndices(ctx: EngineContext): Promise<AllIndices> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const res = await ctx.fetch(ALL_INDICES, {
    headers: { "user-agent": CHROME_UA, accept: "application/json", referer: "https://www.nseindia.com/" },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError("http", `NSE indices HTTP ${res.status}`);
  }
  const data = await res.json<AllIndices>();
  cache = { at: Date.now(), data };
  return data;
}

const num = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;

/** The card for one index: title with level and returns, content with the detail. */
export function indexCard(ix: NseIndex, asOf?: string): EngineResult {
  const parts: string[] = [];
  if (asOf) parts.push(`As of ${asOf} IST.`);
  const periods: string[] = [];
  if (ix.oneWeekAgoVal) {
    periods.push(`1 week ${pct((ix.last / ix.oneWeekAgoVal - 1) * 100)} (from ${num(ix.oneWeekAgoVal)} on ${ix.oneWeekAgo})`);
  }
  if (ix.perChange30d !== undefined && ix.oneMonthAgoVal) {
    periods.push(`1 month ${pct(ix.perChange30d)} (from ${num(ix.oneMonthAgoVal)} on ${ix.date30dAgo})`);
  }
  if (ix.perChange365d !== undefined && ix.oneYearAgoVal) {
    periods.push(`1 year ${pct(ix.perChange365d)} (from ${num(ix.oneYearAgoVal)} on ${ix.date365dAgo})`);
  }
  if (periods.length) parts.push(`Price returns: ${periods.join("; ")}. Price returns exclude dividends.`);
  if (ix.yearLow && ix.yearHigh) parts.push(`52-week range ${num(ix.yearLow)}–${num(ix.yearHigh)}.`);
  const valuation = [
    Number(ix.pe) > 0 && `P/E ${ix.pe}`,
    Number(ix.pb) > 0 && `P/B ${ix.pb}`,
    Number(ix.dy) > 0 && `dividend yield ${ix.dy}%`,
  ].filter(Boolean);
  if (valuation.length) parts.push(`${valuation.join(", ")}.`);
  if (Number(ix.advances) + Number(ix.declines) > 0) parts.push(`Advances ${ix.advances}, declines ${ix.declines}.`);

  const day = ix.percentChange !== undefined ? ` (${pct(ix.percentChange)} today)` : "";
  const year = ix.perChange365d !== undefined ? ` · 1Y ${pct(ix.perChange365d)}` : "";
  return {
    url: `https://www.nseindia.com/market-data/live-market-indices#${encodeURIComponent(ix.index)}`,
    title: `${ix.index}: ${num(ix.last)}${day}${year}`,
    content: parts.join(" "),
    publishedDate: asOf ? new Date(parseIst(asOf) ?? Date.now()).toISOString() : undefined,
    author: "NSE",
  };
}

export const indexData: Engine = {
  name: "index data",
  shortcut: "idx",
  categories: ["news", "general"],
  // Data cards answer the question directly; rank them above articles (the
  // second card in a comparison still scores weight / 2).
  weight: 8,
  timeRangeSupport: true,
  timeout: 4000,
  about: "Live NSE index levels and 1W/1M/1Y price returns (NSE allIndices API)",
  request() {
    return null; // not used: see search()
  },
  response() {
    return [];
  },
  async search(params: SearchParams, ctx: EngineContext) {
    if (!/nifty|vix|midcap|smallcap|next 50|index/i.test(params.query)) return [];
    const all = await loadIndices(ctx);
    const rows = all.data ?? [];
    const names = matchIndices(params.query, rows.map((r) => r.index));
    return names
      .map((name) => rows.find((r) => r.index === name))
      .filter((r): r is NseIndex => !!r)
      .map((r) => indexCard(r, all.timestamp));
  },
};
