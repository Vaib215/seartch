// Search engines for Indian financial publishers' own site search (not in SearXNG).
//
// - financial express: the site's WordPress REST API (posts?search=). Relevance
//                      order by default; newest first with an `after=` bound when
//                      a time range is given.
// - economic times:    topics_all.cms, the HTML fragment ET's topic/search page
//                      loads its article list from. searchresult.cms itself just
//                      redirects to /topic/<q>, and for company names on to the
//                      company's stock page, which has no result list.
// - business standard: the JSON API behind business-standard.com/search
//                      (apibs.business-standard.com/search). Results are newest
//                      first and loosely matched, so they're filtered by the query.
//
// Left out: The Hindu BusinessLine (search is a Google CSE widget; the CSE
// endpoint answers automated requests with "Sorry..."), Business Today (/search
// redirects to /custom-search, a "page no longer available" stub; only topic-slug
// pages remain) and Inshorts (trending_topics/<q> only resolves topic slugs, and
// e.g. "infosys" returns cards from 2013; the web app has no free-text search).

import { decodeEntities } from "../../util";
import { CHROME_UA, raiseForHttpError } from "../http";
import { extractText, htmlToText, parseHtml } from "../html";
import { type Engine, type EngineContext, type EngineResult, type TimeRange, EngineError } from "../types";
import { queryTerms } from "./india_news";

const DAY_MS = 86_400_000;
const TIME_RANGE_MS: Record<TimeRange, number> = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS };

function cutoff(timeRange: TimeRange): Date {
  return new Date(Date.now() - TIME_RANGE_MS[timeRange]);
}

/** Drops results older than the requested time range (when they carry a date). */
function withinRange(results: EngineResult[], timeRange?: TimeRange): EngineResult[] {
  if (!timeRange) return results;
  const min = cutoff(timeRange).getTime();
  return results.filter((r) => !r.publishedDate || Date.parse(r.publishedDate) >= min);
}

/** Non-article pages: videos, galleries, web stories, horoscopes, live TV. */
const NOISE_URL = /\/(videos?|video-gallery|photos?|photogallery|slideshow|videoshow|web-stories?|webstories|podcasts?|horoscope|astrology|live-tv)(\/|$)/i;

function dedupe(results: EngineResult[]): EngineResult[] {
  const seen = new Set<string>();
  return results.filter((r) => !seen.has(r.url) && seen.add(r.url));
}

// --- financial express ------------------------------------------------------------

interface WpPost {
  link?: string;
  date_gmt?: string;
  date?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
}

const FE_PER_PAGE = 20;

export const financialExpress: Engine = {
  name: "financial express",
  shortcut: "fe",
  categories: ["news"],
  paging: true,
  maxPage: 10,
  timeRangeSupport: true,
  raiseForHttpError: false,
  about: "Financial Express site search (WordPress REST API)",
  request(params) {
    const url = new URL("https://www.financialexpress.com/wp-json/wp/v2/posts");
    url.searchParams.set("search", params.query);
    url.searchParams.set("per_page", String(FE_PER_PAGE));
    url.searchParams.set("page", String(params.pageno));
    url.searchParams.set("_fields", "link,title,date_gmt,excerpt");
    if (params.timeRange) {
      // WP compares `after` with the site-local post date; a few hours of slack is
      // harmless and the response is filtered on date_gmt anyway.
      url.searchParams.set("after", cutoff(params.timeRange).toISOString().slice(0, 19));
    }
    // The site's default order is newest first, which surfaces any post that
    // mentions the query once in its body; relevance works inside a date window too.
    url.searchParams.set("orderby", "relevance");
    return { url: url.href, headers: { accept: "application/json" } };
  },
  response(resp, params) {
    // Past the last page WP answers 400 rest_post_invalid_page_number.
    if (resp.status === 400 && params.pageno > 1) return [];
    raiseForHttpError(resp);
    const data = resp.json<WpPost[]>();
    if (!Array.isArray(data)) throw new EngineError("parse", "Financial Express: unexpected response");
    const results: EngineResult[] = [];
    for (const p of data) {
      const url = p.link ?? "";
      const title = htmlToText(p.title?.rendered);
      if (!/^https:\/\/www\.financialexpress\.com\//.test(url) || !title || NOISE_URL.test(url)) continue;
      const raw = p.date_gmt ? `${p.date_gmt}Z` : p.date ? `${p.date}+05:30` : "";
      const ts = raw ? Date.parse(raw) : NaN;
      results.push({
        url,
        title,
        content: htmlToText(p.excerpt?.rendered) || undefined,
        publishedDate: Number.isNaN(ts) ? undefined : new Date(ts).toISOString(),
        author: "Financial Express",
      });
    }
    return withinRange(dedupe(results), params.timeRange);
  },
};

// --- economic times -----------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "09 Oct, 2026, 12.56 AM IST" → ISO (IST is UTC+5:30). */
export function parseEtDate(s: string): string | undefined {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})(?:,?\s+(\d{1,2})[.:](\d{2})\s*([AP]M))?/i.exec(s);
  if (!m) return undefined;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return undefined;
  let hour = m[4] ? Number(m[4]) % 12 : 0;
  if (m[6]?.toUpperCase() === "PM") hour += 12;
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), hour, m[5] ? Number(m[5]) : 0) - 330 * 60_000;
  return new Date(utc).toISOString();
}

export const economicTimes: Engine = {
  name: "economic times",
  shortcut: "et",
  categories: ["news"],
  paging: true,
  maxPage: 10,
  timeRangeSupport: true,
  about: "Economic Times article search (topics_all.cms list; newest first)",
  request(params) {
    const url = new URL("https://economictimes.indiatimes.com/topics_all.cms");
    url.searchParams.set("type", "article");
    url.searchParams.set("query", params.query);
    if (params.pageno > 1) url.searchParams.set("curpg", String(params.pageno));
    return { url: url.href };
  },
  response(resp, params) {
    const root = parseHtml(resp.text);
    const results: EngineResult[] = [];
    for (const item of root.querySelectorAll("div.story_list")) {
      const content = item.querySelector("div.contentD");
      const link = content?.querySelector("a[href]");
      const href = link?.getAttribute("href") ?? "";
      if (!/^https:\/\/economictimes\.indiatimes\.com\/.+\/articleshow\/\d+\.cms/.test(href) || NOISE_URL.test(href)) continue;
      const title = extractText(content!.querySelector("h2")) || decodeEntities(link!.querySelector("meta[itemprop=name]")?.getAttribute("content") ?? "").trim();
      if (!title) continue;
      results.push({
        url: href.split("?")[0],
        title,
        content: extractText(content!.querySelector("div.syn")) || undefined,
        publishedDate: parseEtDate(extractText(content!.querySelector("time"))),
        author: "The Economic Times",
      });
    }
    return withinRange(dedupe(results), params.timeRange);
  },
};

// --- business standard ------------------------------------------------------------------

// The site's API client obfuscates its query string and API token with this
// alphabet: "<DD><len><text>bs255T", every char written as two base-62 digits.
// DD is the day of the month; the server doesn't appear to check it.
const BS_ALPHABET = "95867qrstuvwxyzabcdefghijklmnop01234JKLMNOPQRSTUVWXYZABCDEFGHI";
const BS_TOKEN_NAME = "QlNBUElTRUNSRVRLRVk"; // the client encodes this literal string
const BS_MAX_INPUT = 99; // the client refuses longer inputs
const BS_LIMIT = 20;
const BS_MIN_QUOTED = 5;

export function bsEncode(text: string, now = new Date()): string {
  const day = String(new Date(now.getTime() + 330 * 60_000).getUTCDate()).padStart(2, "0");
  const plain = `${day}${String(text.length).padStart(2, "0")}${text}bs255T`;
  let out = "";
  for (const ch of plain) {
    const code = ch.charCodeAt(0);
    out += BS_ALPHABET[Math.floor(code / 62) % 62] + BS_ALPHABET[code % 62];
  }
  return out;
}

function bsListData(keyword: string, page: number): string {
  const make = (k: string) => JSON.stringify({ type: "news", limit: BS_LIMIT, page, keyword: k });
  let k = keyword;
  while (make(k).length > BS_MAX_INPUT && k.length) k = k.slice(0, -1);
  return make(k);
}

function bsRequestUrl(keyword: string, page: number): string {
  return `https://apibs.business-standard.com/search?listData=${bsEncode(bsListData(keyword, page))}`;
}

const BS_HEADERS = () => ({ accept: "application/json", "x-api-token": bsEncode(BS_TOKEN_NAME), origin: "https://www.business-standard.com" });

interface BsNews {
  heading1?: string;
  sub_heading?: string;
  article_url?: string;
  article_type?: string;
  published_date?: number;
}

/**
 * Whether a story is about the query: the first term (usually the company) must
 * appear, and with three or more terms at most one other may be missing.
 */
export function bsMatches(hay: string, terms: string[]): boolean {
  if (!terms.length) return true;
  if (!hay.includes(terms[0])) return false;
  const hits = terms.filter((t) => hay.includes(t)).length;
  return hits >= (terms.length >= 3 ? terms.length - 1 : terms.length);
}

function parseBs(body: any, query: string): EngineResult[] {
  if (!body || body.success !== true) {
    throw new EngineError("http", `Business Standard API: ${String(body?.message ?? "unexpected response").slice(0, 120)}`);
  }
  const terms = queryTerms(query);
  const results: EngineResult[] = [];
  for (const n of (body.data?.news ?? []) as BsNews[]) {
    const path = n.article_url ?? "";
    const title = htmlToText(n.heading1);
    if (!title || !/^\/[a-z0-9-]+\/.+_1\.html$/.test(path) || NOISE_URL.test(path)) continue;
    if (n.article_type && !/article|live/i.test(n.article_type)) continue;
    const content = htmlToText(n.sub_heading);
    // The API matches loosely (and in article bodies); keep stories that are about the query.
    const hay = `${title} ${content} ${path.replace(/[-/_]/g, " ")}`.toLowerCase();
    if (!bsMatches(hay, terms)) continue;
    results.push({
      url: `https://www.business-standard.com${path}`,
      title,
      content: content || undefined,
      publishedDate: n.published_date ? new Date(n.published_date * 1000).toISOString() : undefined,
      author: "Business Standard",
    });
  }
  return dedupe(results);
}

export const businessStandard: Engine = {
  name: "business standard",
  shortcut: "bs",
  categories: ["news"],
  paging: true,
  maxPage: 10,
  timeRangeSupport: true,
  about: "Business Standard site search (the site's JSON API; newest first, filtered by query)",
  request(params) {
    // A quoted keyword keeps short tickers ("TCS") from matching "L&T", "T&D", ...
    return { url: bsRequestUrl(`"${params.query.replace(/"/g, "")}"`, params.pageno), headers: BS_HEADERS() };
  },
  async response(resp, params, ctx: EngineContext) {
    let results = parseBs(resp.json(), params.query);
    // A quoted multi-word query is a phrase match that often finds little (and
    // nothing recent); top up from the unquoted, newest-first search.
    if (results.length < BS_MIN_QUOTED && queryTerms(params.query).length > 1) {
      try {
        const res = await ctx.fetch(bsRequestUrl(params.query.replace(/"/g, ""), params.pageno), {
          headers: { "user-agent": CHROME_UA, ...BS_HEADERS() },
        });
        if (res.ok) results = dedupe([...results, ...parseBs(await res.json(), params.query)]);
        else await res.body?.cancel();
      } catch {
        // keep the quoted results
      }
    }
    return withinRange(results, params.timeRange);
  },
};

export const indiaPublisherEngines: Engine[] = [financialExpress, economicTimes, businessStandard];

// Exported for tests.
export const _internal = { bsListData, parseBs };
