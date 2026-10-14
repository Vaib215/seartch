// Indian business/market news engines (not in SearXNG).
//
// - bing news:          Bing News RSS. Unlike Bing web search, the news feed
//                       answers Worker requests with relevant, dated results.
// - india finance news: Yandex restricted with site: filters to Indian
//                       financial publishers.
// - india market feeds: the publishers' own RSS feeds, filtered by the query.
//                       Only covers the last day or two, but includes stories
//                       search engines haven't indexed yet.

import { cleanText, decodeEntities, mapLimit } from "../../util";
import { CHROME_UA } from "../http";
import { matchKey, resolveCompanies } from "../companies";
import { containsTerm, jargonHits, mentionsSubject, normalizeText, splitQuery } from "../terms";
import { type Engine, type EngineResult, type SearchParams, type TimeRange, EngineError } from "../types";
import { yandex } from "./yandex";

const TIME_RANGE_MS: Record<TimeRange, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  quarter: 91 * 86_400_000,
  year: 365 * 86_400_000,
};

/** Drops results older than the requested time range (when they carry a date). */
function withinRange(results: EngineResult[], timeRange?: TimeRange): EngineResult[] {
  if (!timeRange) return results;
  const cutoff = Date.now() - TIME_RANGE_MS[timeRange];
  return results.filter((r) => !r.publishedDate || Date.parse(r.publishedDate) >= cutoff);
}

// --- RSS parsing -------------------------------------------------------------

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  date?: string;
  source?: string;
}

function tagText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

export function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const title = cleanText(decodeEntities(tagText(block, "title")));
    const link = decodeEntities(tagText(block, "link")).trim();
    if (!title || !/^https?:\/\//.test(link)) continue;
    const rawDate = tagText(block, "pubDate") || tagText(block, "dc:date") || tagText(block, "published") || tagText(block, "updated");
    const parsed = rawDate ? Date.parse(rawDate) : NaN;
    items.push({
      title,
      link,
      description: cleanText(decodeEntities(tagText(block, "description"))),
      date: Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString(),
      source: cleanText(tagText(block, "News:Source") || tagText(block, "source")) || undefined,
    });
  }
  return items;
}

// --- bing news -----------------------------------------------------------------

// Bing News `qft` intervals: 7 = past 24h, 8 = past week, 9 = past month.
const BING_INTERVAL: Partial<Record<TimeRange, string>> = { day: "7", week: "8", month: "9" };
// "all" defaults to the Indian market: this deployment serves Indian stock research.
const DEFAULT_MARKET = { setlang: "en-IN", cc: "IN" };

export const bingNews: Engine = {
  name: "bing news",
  shortcut: "bin",
  categories: ["news"],
  timeRangeSupport: true,
  request(params) {
    const url = new URL("https://www.bing.com/news/search");
    url.searchParams.set("q", params.query);
    url.searchParams.set("format", "rss");
    const [lang, region] = params.language.split("-");
    if (params.language === "all" || !lang) {
      url.searchParams.set("setlang", DEFAULT_MARKET.setlang);
      url.searchParams.set("cc", DEFAULT_MARKET.cc);
    } else {
      url.searchParams.set("setlang", params.language);
      if (region) url.searchParams.set("cc", region);
    }
    const interval = params.timeRange && BING_INTERVAL[params.timeRange];
    if (interval) url.searchParams.set("qft", `interval="${interval}"`);
    return { url: url.href, headers: { accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" } };
  },
  response(resp, params) {
    if (!/<item[\s>]/i.test(resp.text)) {
      // An item-less feed from Bing is how it rate-limits or soft-blocks a client.
      const sample = cleanText(resp.text.replace(/<[^>]+>/g, " ")).slice(0, 160);
      throw new EngineError("http", `Bing News returned an empty feed${sample ? `: ${sample}` : ""}`);
    }
    const results = parseRss(resp.text).map((it) => ({
      url: unwrapBingNews(it.link),
      title: it.title,
      content: it.description,
      publishedDate: it.date,
      author: it.source,
    }));
    return withinRange(results, params.timeRange);
  },
};

/** apiclick.aspx?...&url=<publisher URL>&... → publisher URL */
export function unwrapBingNews(link: string): string {
  try {
    const u = new URL(link);
    const target = u.searchParams.get("url");
    if (u.hostname.endsWith("bing.com") && target && /^https?:\/\//.test(target)) return target;
  } catch {
    // fall through
  }
  return link;
}

// --- india finance news (Yandex + site: filters) ----------------------------------

export const INDIA_FINANCE_SITES = [
  "economictimes.indiatimes.com",
  "livemint.com",
  "business-standard.com",
  "moneycontrol.com",
  "cnbctv18.com",
  "thehindubusinessline.com",
  "ndtvprofit.com",
  "financialexpress.com",
  "businesstoday.in",
];

const SITE_FILTER = `(${INDIA_FINANCE_SITES.map((s) => `site:${s}`).join(" | ")})`;

export const indiaFinanceNews: Engine = {
  ...yandex,
  name: "india finance news",
  shortcut: "ifn",
  categories: ["news"],
  disabled: false,
  request(params, ctx) {
    return yandex.request({ ...params, query: `${params.query} ${SITE_FILTER}` }, ctx);
  },
};

// --- india market feeds -------------------------------------------------------------

// Each URL answered with RSS to a Worker request (tested from Cloudflare's DEL colo).
// Moneycontrol (JS bot check), Zee Business (403) and Financial Express (HTML, but
// covered by its own engine) are deliberately absent.
export const MARKET_FEEDS: Record<string, string> = {
  "ET Markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  "ET Stocks": "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms",
  "ET Earnings": "https://economictimes.indiatimes.com/markets/stocks/earnings/rssfeeds/2146846.cms",
  "ET Companies": "https://economictimes.indiatimes.com/news/company/corporate-trends/rssfeeds/2143429.cms",
  "ET IPOs": "https://economictimes.indiatimes.com/markets/ipos/fpos/rssfeeds/14655708.cms",
  "ET Economy": "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms",
  "Mint Markets": "https://www.livemint.com/rss/markets",
  "Mint Companies": "https://www.livemint.com/rss/companies",
  "Mint Economy": "https://www.livemint.com/rss/economy",
  "Mint Money": "https://www.livemint.com/rss/money",
  "Business Standard Markets": "https://www.business-standard.com/rss/markets-106.rss",
  "Business Standard Companies": "https://www.business-standard.com/rss/companies-101.rss",
  "Business Standard Results": "https://www.business-standard.com/rss/companies/results-10101.rss",
  "Business Standard Economy": "https://www.business-standard.com/rss/economy-102.rss",
  "Business Standard Finance": "https://www.business-standard.com/rss/finance-103.rss",
  "Business Standard IPOs": "https://www.business-standard.com/rss/markets/ipo-10611.rss",
  "CNBC TV18 Market": "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml",
  "CNBC TV18 Earnings": "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/earnings.xml",
  "CNBC TV18 Business": "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml",
  "CNBC TV18 Economy": "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/economy.xml",
  "BusinessLine Markets": "https://www.thehindubusinessline.com/markets/feeder/default.rss",
  "BusinessLine Companies": "https://www.thehindubusinessline.com/companies/feeder/default.rss",
  "BusinessLine Economy": "https://www.thehindubusinessline.com/economy/feeder/default.rss",
  "NDTV Profit": "https://feeds.feedburner.com/ndtvprofit-latest",
  "Business Today Markets": "https://www.businesstoday.in/rssfeeds/?id=225346",
  "Business Today": "https://www.businesstoday.in/rssfeeds/?id=home",
};

// Daily operational notices (liquidity auctions, money-market data, T-bill cut-offs)
// that match words like "repo" or "rate" but are never what a search is after.
const ROUTINE_NOTICE = /money market operations|variable rate (reverse )?repo|\bvrr\b|\bvrrr\b|auction|treasury bills?|cut-off|weekly statistical supplement|reserve money|government stock|state government securities|sovereign gold bond.*(price|redemption)|lending rates of scheduled/i;
const ASKS_ABOUT_OPERATIONS = /auction|money market|t-?bill|treasury|liquidity|vrr|g-?sec|bond/i;

// Official sources. `label` names the regulator, which its own feed items never mention.
export const REGULATOR_FEEDS: Record<string, { url: string; label: string }> = {
  "RBI Press Releases": { url: "https://www.rbi.org.in/pressreleases_rss.xml", label: "RBI Reserve Bank of India" },
  "RBI Notifications": { url: "https://www.rbi.org.in/notifications_rss.xml", label: "RBI Reserve Bank of India" },
  SEBI: { url: "https://www.sebi.gov.in/sebirss.xml", label: "SEBI Securities and Exchange Board of India" },
  PIB: { url: "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3", label: "PIB Government of India" },
};

const FEED_TTL_SECONDS = 600;
const FEED_TIMEOUT_MS = 5000;
// Workers allow 6 connections in flight per request; leave room for the other engines.
const FEED_CONCURRENCY = 4;

// Parsed feeds per isolate, backed by the Cache API so other isolates in the
// data center reuse them; feeds change every few minutes, not per request.
const feedCache = new Map<string, { at: number; items: FeedItem[] }>();

async function loadFeed(name: string, url: string): Promise<FeedItem[]> {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.at < FEED_TTL_SECONDS * 1000) return hit.items;
  const cacheKey = `https://seartch.internal/feed?u=${encodeURIComponent(url)}`;
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const items = await cached.json<FeedItem[]>();
      feedCache.set(url, { at: Date.now(), items });
      return items;
    }
  } catch {
    // No Cache API here (tests, previews): fetch directly.
  }
  const res = await fetch(url, {
    headers: { "user-agent": CHROME_UA, accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${name}: HTTP ${res.status}`);
  }
  const items = parseRss(await res.text()).map((it) => ({ ...it, source: it.source ?? name }));
  feedCache.set(url, { at: Date.now(), items });
  try {
    await caches.default.put(
      cacheKey,
      new Response(JSON.stringify(items), { headers: { "cache-control": `max-age=${FEED_TTL_SECONDS}` } }),
    );
  } catch {
    // Caching is best-effort.
  }
  return items;
}

async function loadFeeds(feeds: [string, string][]): Promise<FeedItem[][]> {
  const loaded = await mapLimit(feeds, FEED_CONCURRENCY, ([name, url]) => loadFeed(name, url).catch(() => null));
  const ok = loaded.filter((x): x is FeedItem[] => x !== null);
  if (!ok.length) throw new EngineError("network", "no feed could be loaded");
  return ok;
}

/**
 * Items about the query's subject, ranked by how much reporting jargon they
 * share with it ("Q2", "September quarter", "results"...), then newest first.
 * `aliases` (a resolved company's names and ticker) replace the subject words.
 * `context` is text every item implicitly carries, e.g. the regulator's name.
 */
export function filterFeedItems(items: FeedItem[], query: string, aliases: string[] = [], context = ""): FeedItem[] {
  const terms = splitQuery(query);
  if (!terms.subject.length && !aliases.length) return [];
  const seen = new Set<string>();
  const scored: { it: FeedItem; hits: number; t: number }[] = [];
  for (const it of items) {
    if (seen.has(it.link)) continue;
    const text = `${context} ${it.title} ${it.description}`;
    const hay = matchKey(normalizeText(text));
    const about = aliases.length
      ? aliases.some((a) => containsTerm(hay, matchKey(a))) || mentionsSubject(text, terms)
      : mentionsSubject(text, terms);
    if (!about) continue;
    seen.add(it.link);
    scored.push({ it, hits: jargonHits(text, terms), t: it.date ? Date.parse(it.date) : 0 });
  }
  scored.sort((a, b) => b.hits - a.hits || b.t - a.t);
  return scored.map((s) => s.it);
}

function toResults(items: FeedItem[], titlePrefix = ""): EngineResult[] {
  return items.map((it) => ({
    url: it.link,
    title: titlePrefix ? `${titlePrefix}: ${it.title}` : it.title,
    content: it.description,
    publishedDate: it.date,
    author: it.source,
  }));
}

export const indiaMarketFeeds: Engine = {
  name: "india market feeds",
  shortcut: "imf",
  categories: ["news"],
  timeRangeSupport: true,
  timeout: 8000,
  request() {
    return null; // not used: see search()
  },
  response() {
    return [];
  },
  async search(params: SearchParams) {
    const [feeds, companies] = await Promise.all([loadFeeds(Object.entries(MARKET_FEEDS)), resolveCompanies(params.query)]);
    const aliases = companies.flatMap((c) => c.aliases);
    const matches = toResults(filterFeedItems(feeds.flat(), params.query, aliases));
    return withinRange(matches, params.timeRange).slice(0, 25);
  },
};

export const regulators: Engine = {
  name: "regulators",
  shortcut: "reg",
  categories: ["news", "filings"],
  timeRangeSupport: true,
  timeout: 8000,
  request() {
    return null; // not used: see search()
  },
  response() {
    return [];
  },
  async search(params: SearchParams) {
    const entries = Object.entries(REGULATOR_FEEDS);
    const loaded = await mapLimit(entries, FEED_CONCURRENCY, ([name, f]) => loadFeed(name, f.url).catch(() => null));
    if (loaded.every((x) => x === null)) throw new EngineError("network", "no regulator feed could be loaded");
    const results: EngineResult[] = [];
    const routineOk = ASKS_ABOUT_OPERATIONS.test(params.query);
    entries.forEach(([name, f], i) => {
      const items = loaded[i]
        ? filterFeedItems(loaded[i], params.query, [], f.label).filter((it) => routineOk || !ROUTINE_NOTICE.test(it.title))
        : [];
      results.push(...toResults(items, f.label.split(" ")[0]).map((r) => ({ ...r, author: name })));
    });
    return withinRange(results, params.timeRange).slice(0, 15);
  },
};
