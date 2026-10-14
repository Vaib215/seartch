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
import { type Engine, type EngineResult, type SearchParams, type TimeRange, EngineError } from "../types";
import { yandex } from "./yandex";

const TIME_RANGE_MS: Record<TimeRange, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
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

export const MARKET_FEEDS: Record<string, string> = {
  "ET Markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  "ET Stocks": "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms",
  "Mint Markets": "https://www.livemint.com/rss/markets",
  "Mint Companies": "https://www.livemint.com/rss/companies",
  "Business Standard Markets": "https://www.business-standard.com/rss/markets-106.rss",
  "Business Standard Companies": "https://www.business-standard.com/rss/companies-101.rss",
  "CNBC TV18 Market": "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml",
  "BusinessLine Markets": "https://www.thehindubusinessline.com/markets/feeder/default.rss",
  "NDTV Profit": "https://feeds.feedburner.com/ndtvprofit-latest",
  "Business Today Markets": "https://www.businesstoday.in/rssfeeds/?id=225346",
};

const FEED_TTL_MS = 10 * 60_000;
const FEED_TIMEOUT_MS = 5000;
// Words that don't help pick out a story; "Infosys news today" should match on "infosys".
const STOPWORDS = new Set([
  "news", "latest", "today", "update", "updates", "share", "shares", "stock", "stocks", "price",
  "the", "a", "an", "of", "in", "on", "for", "and", "to", "is", "what", "why", "how", "india", "indian",
]);

// Parsed feeds per isolate; feeds change every few minutes, not per request.
const feedCache = new Map<string, { at: number; items: FeedItem[] }>();

async function loadFeed(name: string, url: string): Promise<FeedItem[]> {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.items;
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
  return items;
}

export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}&.-]+/u)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Items whose title+description contain every query term, newest first. */
export function filterFeedItems(items: FeedItem[], query: string): FeedItem[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const seen = new Set<string>();
  return items
    .filter((it) => {
      const hay = `${it.title} ${it.description}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t)) || seen.has(it.link)) return false;
      seen.add(it.link);
      return true;
    })
    .sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
}

export const indiaMarketFeeds: Engine = {
  name: "india market feeds",
  shortcut: "imf",
  categories: ["news"],
  timeRangeSupport: true,
  timeout: 6000,
  request() {
    return null; // not used: see search()
  },
  response() {
    return [];
  },
  async search(params: SearchParams) {
    const feeds = Object.entries(MARKET_FEEDS);
    const loaded = await mapLimit(feeds, 5, ([name, url]) => loadFeed(name, url).catch(() => null));
    const ok = loaded.filter((x): x is FeedItem[] => x !== null);
    if (!ok.length) throw new EngineError("network", "no market feed could be loaded");
    const matches = filterFeedItems(ok.flat(), params.query).map((it) => ({
      url: it.link,
      title: it.title,
      content: it.description,
      publishedDate: it.date,
      author: it.source,
    }));
    return withinRange(matches, params.timeRange).slice(0, 20);
  },
};
