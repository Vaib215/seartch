// Analysis and explainer articles about the company a query names: how it makes
// and collects money (business model, cash flow, working capital, order book),
// from Value Research, Capitalmind, Finshots, BusinessLine, Mint, Business
// Standard and Moneycontrol.
//
// Own site search is used where it is reachable from Cloudflare and allowed:
// only Business Standard's (the JSON API behind business-standard.com/search,
// as the "business standard" news engine uses). The others go through TinyFish
// restricted to their domains (checked 2026-10-17): Value Research's search is
// client-side over /api/ (disallowed in robots.txt), Mint's /search answers 410,
// BusinessLine's is a Google CSE widget, Finshots' (Ghost) search API sits under
// the robots-disallowed /ghost/, Capitalmind has no search and blocks its
// WordPress API (403), and Moneycontrol serves a bot check.

import { type Company, resolveCompanies } from "../companies";
import { dateFromUrl } from "../dates";
import { isJunkPage, isNonArticle } from "../news_filter";
import { namesCompany, splitQuery, termHits, topicTerms } from "../terms";
import { tinyfishSearch } from "../tinyfish";
import type { Engine, EngineContext, EngineResult, SearchParams, TimeRange } from "../types";
import { EngineError } from "../types";
import { CHROME_UA } from "../http";
import { businessStandard } from "./india_publishers";
import { Budget, cacheGet, cachePut, commonName, companyKey, urlWords } from "./research_common";

export const ANALYSIS_SITES = [
  "valueresearchonline.com",
  "capitalmind.in",
  "finshots.in",
  "thehindubusinessline.com",
  "livemint.com",
  "business-standard.com",
  "moneycontrol.com",
];
// Sites that publish company deep-dives rather than news.
const DEEP_SITES = ["valueresearchonline.com", "capitalmind.in", "finshots.in", "thehindubusinessline.com"];

const PUBLISHERS: [RegExp, string][] = [
  [/valueresearchonline\.com$/, "Value Research"],
  [/capitalmind\.in$/, "Capitalmind"],
  [/finshots\.in$/, "Finshots"],
  [/thehindubusinessline\.com$/, "BusinessLine"],
  [/livemint\.com$/, "Mint"],
  [/business-standard\.com$/, "Business Standard"],
  [/moneycontrol\.com$/, "Moneycontrol"],
];

const ENGINE_TIMEOUT_MS = 6500;
const BUDGET_MS = 6000;
const CACHE_TTL_S = 2 * 3600;
const PARTIAL_CACHE_TTL_S = 600;
const MAX_RESULTS = 15;
const MAX_OWN_SEARCH = 4;
const TINYFISH_PURPOSE = "Analysis and explainers of how an Indian listed company makes and collects money: business model, cash flow, working capital, order book";

// Quote, data, filing, live-blog and press-release pages: they describe the stock
// or the day's market, not the business.
const NOT_ANALYSIS = [
  /valueresearchonline\.com\/(stocks|funds|nps|etf)\//i,
  /thehindubusinessline\.com\/stocks\//i,
  /livemint\.com\/(market\/market-stats|companies\/company-results)\//i,
  /bsmedia\.business-standard\.com\/_media\/bs\/data\/announcements\//i,
  /business-standard\.com\/content\/press-releases/i,
  /moneycontrol\.com\/(india\/stockpricequote|stocks|financials|company-facts|markets\/financials)/i,
  /images\.moneycontrol\.com\/backends\/livefeed_pdf\//i,
  /\/(topic|topics|tags?|author|authors)\//i,
  /live-?updates|liveblog|live-blog|stock-market-highlights|share-market-highlights|market-highlights/i,
];
// Results listings: "Q1 results: ABREL, Godrej, ... and 693 more on Aug 13".
const ROUNDUP = /\band \d+ more\b|\bamong \d+ (on|companies)\b|\bstocks to (buy|watch)\b|\btop (gainers|losers)\b|^business news highlights/i;
// Words that explain a business rather than report a day's news.
const EXPLAINER = [
  /business model/i, /cash flows?|free cash/i, /working capital/i, /order book/i, /receivables?|debtors?/i, /where is the cash/i,
  /\bexplain(ed|er|s)?\b/i, /deep dive/i, /\banaly[sz](is|ing|es)\b/i, /\bdecod(e|ed|ing)\b/i, /\bmoat\b/i,
  /unit economics/i, /makes? money/i, /\bcapex\b/i, /balance sheet/i, /capital allocation/i, /\bvaluation\b/i,
  /\bstock insight\b/i, /\bcase study\b/i, /\b(bull|bear) case\b/i, /\bwhy\b/i, /\bhow\b/i, /\blessons?\b/i,
  /\boutlook\b/i, /\breview\b/i,
];
// Sections that carry company analysis, and sections that carry trading calls.
const ANALYSIS_SECTION = [
  /valueresearchonline\.com\/stories\//i,
  /capitalmind\.in\//i,
  /finshots\.in\//i,
  /thehindubusinessline\.com\/portfolio\/(news-analysis|stock-fundamental-analysis-india|big-story|portfolio-strategy)\//i,
  /livemint\.com\/(opinion|market\/mark-to-market)\//i,
  /moneycontrol\.com\/news\/business\/(moneycontrol-research|earnings)\//i,
];
const TRADING_SECTION = /technical-analysis|commodity-analysis|f-?o-query|fo-query|tech-query|should-you-buy-sell-or-hold|stock-picks?/i;
const PRICE_MOVE = /\b(shares?|stock|scrip)\b[^.]{0,40}\b(soar|jump|surge|rall|tank|fall|plunge|zoom|rise|gain|slump|crash|hits?|climb|drop|settle|end|up \d|down \d)/i;
const RESULTS_NEWS = /\bq[1-4]\b[^.]{0,40}\b(profit|revenue|results?)\b|\bnet profit (rises|falls|jumps|drops|up|down)\b/i;
const BROKER_PDF = /(images\.moneycontrol\.com\/static-mcnews\/.+\.pdf$)|(bsmedia\.business-standard\.com\/_media\/bs\/data\/market-reports\/equity-brokertips\/)/i;
const PER_PUBLISHER = 4;
// What an article (not a section or listing page) looks like on each site.
const ARTICLE_URL: [RegExp, RegExp][] = [
  [/thehindubusinessline\.com$/, /\/article\d+\.ece$/],
  [/livemint\.com$/, /-\d{10,}\.html$/],
  [/business-standard\.com$/, /_1\.html$|\.pdf$/],
  [/moneycontrol\.com$/, /-\d+\.html$|\.pdf$/],
  [/valueresearchonline\.com$/, /\/stories\/(\d+|stock\/\d+)\/[^/]+/],
  [/finshots\.in$/, /^\/[^/]+\/[^/]+/],
  [/capitalmind\.in$/, /^\/(?!insights\/page\/)[^/]+\/[^/]+|^\/[^/]*-[^/]*-[^/]+/],
];

function isArticle(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const h = u.hostname.replace(/^www\./, "");
  const rule = ARTICLE_URL.find(([site]) => site.test(h));
  return !rule || rule[1].test(u.pathname.replace(/\/$/, ""));
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function canonical(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url;
  }
}

export function publisher(url: string): string | undefined {
  const h = host(url);
  return PUBLISHERS.find(([re]) => re.test(h))?.[1];
}

interface Scored {
  r: EngineResult;
  score: number;
}

/**
 * Keeps analysis about the company and orders it: names the company in the
 * headline or URL, covers the query's topic, reads like an explainer, comes from
 * a deep-dive publisher; price-move news and roundups rank low or go.
 */
export function rankAnalysis(results: EngineResult[], query: string, c: Company, now = Date.now()): EngineResult[] {
  const terms = splitQuery(query);
  const topics = topicTerms(query, c.aliases);
  const seen = new Set<string>();
  const scored: Scored[] = [];
  for (const raw of results) {
    const key = canonical(raw.url);
    if (seen.has(key)) continue;
    if (!isArticle(raw.url) || isNonArticle(raw.url) || isJunkPage(raw.url) || NOT_ANALYSIS.some((re) => re.test(raw.url))) continue;
    if (ROUNDUP.test(raw.title)) continue;
    const head = `${raw.title} ${urlWords(raw.url)}`;
    const strong = namesCompany(head, terms, c.aliases);
    if (!strong && !namesCompany(raw.content ?? "", terms, c.aliases)) continue;
    seen.add(key);
    const pub = publisher(raw.url);
    const date = raw.publishedDate ?? dateFromUrl(raw.url);
    const age = date ? (now - Date.parse(date)) / 86_400_000 : Infinity;
    const broker = BROKER_PDF.test(raw.url);
    const hits = (s: string) => EXPLAINER.filter((re) => re.test(s)).length;
    let score = strong ? 3 : 1;
    score += 2 * termHits(`${head} ${raw.content ?? ""}`, topics);
    score += 1.5 * Math.min(2, hits(head)) + 0.5 * Math.min(2, hits(raw.content ?? ""));
    if (ANALYSIS_SECTION.some((re) => re.test(raw.url))) score += 1.5;
    if (broker) score += 1;
    if (TRADING_SECTION.test(raw.url)) score -= 2;
    if (PRICE_MOVE.test(raw.title)) score -= 2;
    if (RESULTS_NEWS.test(raw.title)) score -= 1;
    if (age < 365) score += 0.5;
    scored.push({
      r: {
        ...raw,
        title: broker ? `${raw.title.replace(/\s*(\.\.\.|…)$/, "")} — broker research note (PDF)` : raw.title,
        publishedDate: date,
        author: broker ? `${pub ?? "Broker"} (broker research)` : (pub ?? raw.author),
      },
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score || (Date.parse(b.r.publishedDate ?? "") || 0) - (Date.parse(a.r.publishedDate ?? "") || 0));
  // A few per publisher, so one site's news feed can't crowd out the others' analysis.
  const perPublisher = new Map<string, number>();
  return scored
    .filter(({ r }) => {
      const n = perPublisher.get(r.author ?? "") ?? 0;
      perPublisher.set(r.author ?? "", n + 1);
      return n < PER_PUBLISHER;
    })
    .map((s) => s.r);
}

/** Whether a result reads like analysis (an explainer word or the query's topic in its headline or URL). */
export function looksLikeAnalysis(r: EngineResult, query: string, c: Company): boolean {
  const head = `${r.title} ${urlWords(r.url)}`;
  return (
    EXPLAINER.some((re) => re.test(head)) ||
    ANALYSIS_SECTION.some((re) => re.test(r.url)) ||
    termHits(head, topicTerms(query, c.aliases)) > 0
  );
}

/** Business Standard's own search, for the company's name. */
async function businessStandardSearch(c: Company, params: SearchParams, ctx: EngineContext): Promise<EngineResult[]> {
  const p: SearchParams = { ...params, query: commonName(c), pageno: 1 };
  const req = await businessStandard.request(p, ctx);
  if (!req) return [];
  const res = await ctx.fetch(req.url, { headers: { "user-agent": CHROME_UA, ...req.headers } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError(res.status === 403 ? "access_denied" : res.status === 429 ? "too_many_requests" : "http", `Business Standard: HTTP ${res.status}`);
  }
  const text = await res.text();
  const results = await businessStandard.response(
    { status: res.status, url: req.url, headers: res.headers, text, json: () => JSON.parse(text) },
    p,
    ctx,
  );
  return results.slice(0, 20);
}

function tinyfishQueries(c: Company, query: string): { q: string; domains: string[] }[] {
  const name = commonName(c);
  const topics = topicTerms(query, c.aliases).join(" ");
  // Short queries: a list of finance keywords drowns the company name.
  return [
    { q: `${name} ${topics || "business model"} analysis`, domains: ANALYSIS_SITES },
    { q: `${name} ${topics || "analysis business"} explained`, domains: DEEP_SITES },
  ];
}

interface Gathered {
  results: EngineResult[];
  errors: EngineError[];
}

async function gather(c: Company, params: SearchParams, ctx: EngineContext, budget: Budget): Promise<Gathered> {
  const errors: EngineError[] = [];
  const settle = (p: Promise<EngineResult[]>, label: string) =>
    budget.race(p, label).catch((e) => {
      errors.push(e instanceof EngineError ? e : new EngineError("network", `${label}: ${e instanceof Error ? e.message : String(e)}`));
      return [] as EngineResult[];
    });
  const signal = budget.signal(ctx.signal);
  const tasks = tinyfishQueries(c, params.query).map(({ q, domains }) =>
    settle(tinyfishSearch(q, { includeDomains: domains, purpose: TINYFISH_PURPOSE, timeRange: params.timeRange }, signal), "TinyFish"),
  );
  const own = settle(businessStandardSearch(c, params, ctx), "Business Standard");
  const [tf, bs] = await Promise.all([Promise.all(tasks), own]);
  // Own-search news is kept to a few: it is newest-first, not explainer-first.
  const bsRanked = rankAnalysis(bs.filter((r) => looksLikeAnalysis(r, params.query, c)), params.query, c).slice(0, MAX_OWN_SEARCH);
  return { results: [...tf.flat(), ...bsRanked], errors };
}

const TIME_RANGE_MS: Record<TimeRange, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, quarter: 91 * 86_400_000, year: 365 * 86_400_000 };

export const analysis: Engine = {
  name: "analysis",
  shortcut: "an",
  categories: ["analysis"],
  timeout: ENGINE_TIMEOUT_MS,
  timeRangeSupport: true,
  about: "Analysis and explainers (business model, cash flow, working capital, order book) from Value Research, Capitalmind, Finshots, BusinessLine, Mint, Business Standard and Moneycontrol",
  request() {
    return null; // not used: see search()
  },
  response() {
    return [];
  },
  async search(params: SearchParams, ctx: EngineContext) {
    const budget = Budget.start(BUDGET_MS);
    const companies = (await budget.race(resolveCompanies(params.query), "company lookup").catch(() => [] as Company[])).slice(0, 2);
    if (!companies.length) return [];
    const topics = topicTerms(params.query, companies.flatMap((c) => c.aliases));
    const perCompany = await Promise.all(
      companies.map(async (c) => {
        const key = `analysis?c=${companyKey(c)}&t=${encodeURIComponent(topics.join(" "))}&r=${params.timeRange ?? ""}`;
        const hit = await cacheGet<EngineResult[]>(key);
        if (hit) return { results: hit, errors: [] as EngineError[] };
        const got = await gather(c, params, ctx, budget);
        const ranked = rankAnalysis(got.results, params.query, c).slice(0, MAX_RESULTS);
        if (ranked.length || !got.errors.length) await cachePut(key, ranked, got.errors.length ? PARTIAL_CACHE_TTL_S : CACHE_TTL_S);
        return { results: ranked, errors: got.errors };
      }),
    );
    const cutoff = params.timeRange ? Date.now() - TIME_RANGE_MS[params.timeRange] : 0;
    const results = perCompany
      .flatMap((p) => p.results)
      .filter((r) => !cutoff || !r.publishedDate || Date.parse(r.publishedDate) >= cutoff);
    if (!results.length) {
      const errors = perCompany.flatMap((p) => p.errors);
      if (errors.length) throw errors[0];
    }
    return results.slice(0, MAX_RESULTS);
  },
};
