// Exchange filings for the company a query names: NSE corporate announcements
// and board meetings (by NSE ticker) plus today's BSE announcements (by BSE
// scrip code). Answers "did X publish results?" from the source, not from
// media coverage. Needs the ticker-search service to resolve the company.

import { type Company, resolveCompanies } from "../companies";
import { filingSubject } from "../filing_text";
import { CHROME_UA } from "../http";
import { jargonHits, splitQuery, termHits, topicTerms } from "../terms";
import {
  type Engine,
  type EngineContext,
  type EngineResult,
  type SearchParams,
  type TimeRange,
  EngineAccessDenied,
  EngineError,
  EngineTooManyRequests,
} from "../types";

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<TimeRange, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };
const DEFAULT_RANGE_DAYS = 91;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const MAX_RESULTS = 15;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const NSE_HEADERS = {
  "user-agent": CHROME_UA,
  accept: "application/json, text/plain, */*",
  referer: "https://www.nseindia.com/",
};
const BSE_FEED = "https://www.bseindia.com/data/xml/announcements.xml";
const BSE_TTL_MS = 10 * 60_000;

export interface Filing {
  source: "NSE" | "BSE";
  company: Company;
  /** Epoch ms. For upcoming board meetings, when the meeting was announced. */
  time: number;
  category: string;
  text: string;
  url: string;
  /** Board meeting date (dd-Mon-yyyy) when it is still ahead. */
  meetingOn?: string;
}

/** "14-Oct-2026 11:15:37" or "14-Oct-2026" in IST → epoch ms. */
export function parseIst(s: string | undefined): number | undefined {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s?.trim() ?? "");
  if (!m) return undefined;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return undefined;
  const local = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return local - IST_OFFSET_MS;
}

/** dd-mm-yyyy for an epoch time, in IST (NSE's from_date/to_date format). */
function nseDate(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** "Tata Elxsi Ltd." → "Tata Elxsi" */
export function shortName(name: string): string {
  return name.replace(/\s+(Ltd\.?|Limited)$/i, "").trim();
}

/**
 * NSE summaries repeat the boilerplate "X Limited has informed the Exchange
 * about ..."; keep what follows.
 */
export function cleanSummary(text: string): string {
  return text
    .replace(/^.*?\bhas (?:informed|submitted to|intimated) the Exchange\b,?\s*(?:about|regarding|that)?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getJson(ctx: EngineContext, url: string): Promise<unknown> {
  const res = await ctx.fetch(url, { headers: NSE_HEADERS });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new EngineAccessDenied(`NSE HTTP ${res.status}`);
  }
  if (res.status === 429) {
    await res.body?.cancel();
    throw new EngineTooManyRequests("NSE rate limit");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError("http", `NSE HTTP ${res.status}`);
  }
  return res.json();
}

interface NseAnnouncement {
  an_dt?: string;
  desc?: string;
  attchmntText?: string;
  attchmntFile?: string;
}

export function mapNseAnnouncements(rows: NseAnnouncement[], company: Company): Filing[] {
  const out: Filing[] = [];
  for (const r of rows) {
    const time = parseIst(r.an_dt);
    if (time === undefined || !r.desc) continue;
    out.push({
      source: "NSE",
      company,
      time,
      category: r.desc.trim(),
      text: cleanSummary(r.attchmntText ?? ""),
      url: r.attchmntFile || `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(company.nse ?? "")}`,
    });
  }
  return out;
}

interface NseBoardMeeting {
  bm_date?: string;
  bm_purpose?: string;
  bm_desc?: string;
  bm_timestamp?: string;
  attachment?: string;
}

/** Board meetings that haven't happened yet (today included); past ones show up as outcomes. */
export function mapUpcomingMeetings(rows: NseBoardMeeting[], company: Company, now = Date.now()): Filing[] {
  const startOfTodayIst = Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  const byDate = new Map<string, Filing>();
  for (const r of rows) {
    const day = parseIst(r.bm_date);
    if (day === undefined || day < startOfTodayIst || !r.bm_date) continue;
    // NSE lists each meeting twice (intimation + purpose); keep the more specific one.
    const existing = byDate.get(r.bm_date);
    if (existing && /intimation/i.test(r.bm_purpose ?? "")) continue;
    byDate.set(r.bm_date, {
      source: "NSE",
      company,
      time: parseIst(r.bm_timestamp) ?? now,
      category: `Board meeting on ${r.bm_date}`,
      text: cleanSummary(r.bm_desc ?? r.bm_purpose ?? ""),
      url: r.attachment || `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(company.nse ?? "")}`,
      meetingOn: r.bm_date,
    });
  }
  return [...byDate.values()];
}

// --- BSE: today's announcements, indexed by scrip code ----------------------------

interface BseItem {
  title: string;
  link: string;
  scripcode: string;
  description: string;
  time?: number;
}

let bseCache: { at: number; byCode: Map<string, BseItem[]> } | undefined;

export function parseBseFeed(xml: string): Map<string, BseItem[]> {
  const byCode = new Map<string, BseItem[]>();
  const tag = (block: string, name: string) =>
    (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1] ?? "")
      .replace(/^<!\[CDATA\[|\]\]>$/g, "")
      .replace(/&amp;/g, "&")
      .trim();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const scripcode = tag(block, "scripcode");
    if (!scripcode) continue;
    const item: BseItem = {
      title: tag(block, "title"),
      link: tag(block, "link"),
      scripcode,
      description: tag(block, "description"),
      time: parseIst(tag(block, "pubDate")),
    };
    const list = byCode.get(scripcode);
    if (list) list.push(item);
    else byCode.set(scripcode, [item]);
  }
  return byCode;
}

async function bseToday(ctx: EngineContext): Promise<Map<string, BseItem[]>> {
  if (bseCache && Date.now() - bseCache.at < BSE_TTL_MS) return bseCache.byCode;
  const res = await ctx.fetch(BSE_FEED, { headers: { "user-agent": CHROME_UA, accept: "application/rss+xml, */*" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError("http", `BSE HTTP ${res.status}`);
  }
  const byCode = parseBseFeed(await res.text());
  bseCache = { at: Date.now(), byCode };
  return byCode;
}

function mapBse(items: BseItem[], company: Company): Filing[] {
  return items
    .filter((it) => it.time !== undefined)
    .map((it) => ({
      source: "BSE" as const,
      company,
      time: it.time!,
      category: "BSE announcement",
      text: it.description,
      url: it.link || `https://www.bseindia.com/stock-share-price/x/y/${company.bse}/`,
    }));
}

// --- Screener: the latest few BSE announcements with written summaries ------------
// screener.in company pages list a company's five latest BSE filings, each with a
// one-line summary that often carries the key figures ("revenue of Rs 1,055.7 Cr,
// up 15% YoY"). robots.txt allows /company/ pages; each is fetched at most every 6h.

const SCREENER_TTL_MS = 6 * 3_600_000;
const screenerCache = new Map<string, { at: number; html: string }>();

export function parseScreenerAnnouncements(html: string, company: Company): Filing[] {
  const start = html.indexOf('id="documents"');
  const section = start >= 0 ? html.slice(start) : html;
  const out: Filing[] = [];
  const re = /<a\s+href="(https:\/\/www\.bseindia\.com\/(?:stockinfo\/AnnPdfOpen\.aspx\?Pname=|xml-data\/corpfiling\/Attach(?:Live|His)\/)[^"]+)"[^>]*>([\s\S]*?)<div[^>]*>\s*<time datetime="([^"]+)"[^>]*>[^<]*<\/time>\s*-?\s*([\s\S]*?)<\/div>/g;
  for (const m of section.matchAll(re)) {
    const time = Date.parse(m[3]);
    if (Number.isNaN(time)) continue;
    const category = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/^Announcement under Regulation 30 \(LODR\)-\s*/i, "").trim();
    const text = m[4].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    out.push({ source: "BSE", company, time, category: category || "BSE announcement", text, url: m[1] });
  }
  return out;
}

async function screenerFilings(ctx: EngineContext, c: Company): Promise<Filing[]> {
  const id = c.nse ?? c.bse;
  if (!id) return [];
  let html = screenerCache.get(id);
  if (!html || Date.now() - html.at > SCREENER_TTL_MS) {
    const res = await ctx.fetch(`https://www.screener.in/company/${encodeURIComponent(id)}/`, {
      headers: { "user-agent": CHROME_UA, accept: "text/html" },
    });
    if (!res.ok) {
      await res.body?.cancel();
      return [];
    }
    html = { at: Date.now(), html: await res.text() };
    screenerCache.set(id, html);
  }
  return parseScreenerAnnouncements(html.html, c);
}

/** BSE attachment id (the PDF's GUID), shared by the feed and Screener links. */
function bseDocId(url: string): string | undefined {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf/i.exec(url)?.[1]?.toLowerCase();
}

/**
 * Screener's summaries are better snippets than NSE's boilerplate: copy them onto
 * the matching NSE filing (same filing within 90 minutes) and return only the
 * Screener items NSE doesn't have.
 */
export function mergeSummaries(nse: Filing[], screener: Filing[]): Filing[] {
  const unmatched: Filing[] = [];
  for (const s of screener) {
    const words = SIGNIFICANT(`${s.category} ${s.text}`);
    let match: Filing | undefined;
    let best = 0;
    for (const n of nse) {
      if (Math.abs(n.time - s.time) > 90 * 60_000) continue;
      const other = SIGNIFICANT(`${n.category} ${n.text}`);
      let shared = 0;
      for (const w of words) if (other.has(w)) shared++;
      if (shared > best) [match, best] = [n, shared];
    }
    if (!match) unmatched.push(s);
    else if (s.text.length > 20 && (isWeakFiling(match) || s.text.length > match.text.length)) match.text = s.text;
  }
  return unmatched;
}

const SIGNIFICANT = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(with|from|that|this|have|been|under|regulation|company|limited)$/.test(w)));

/** Drops BSE filings that are the same document already filed on NSE. */
export function dropCrossListed(bse: Filing[], nse: Filing[]): Filing[] {
  return bse.filter((b) => {
    const words = SIGNIFICANT(b.text);
    return !nse.some((n) => {
      if (Math.abs(n.time - b.time) > 30 * 60_000) return false;
      const other = SIGNIFICANT(`${n.category} ${n.text}`);
      let shared = 0;
      for (const w of words) if (other.has(w)) shared++;
      return shared >= 2;
    });
  });
}

// Categories that say nothing on their own; without a subject line these filings are dropped.
const GENERIC_CATEGORY = /^(general updates|updates|bse announcement|copy of newspaper publication|other|disclosure)$/i;
// How many weak filings per query get their PDF read for a subject line.
const ENRICH_LIMIT = 6;
const ENRICH_CONCURRENCY = 3;
const ENRICH_BUDGET_MS = 7000;

/** A snippet that doesn't tell the reader what the filing is. */
export function isWeakFiling(f: Filing): boolean {
  const text = f.text.trim().toLowerCase();
  return (
    !text ||
    text === f.category.toLowerCase() ||
    text.length < 50 ||
    /^the financial results for the period ended/.test(text) ||
    (GENERIC_CATEGORY.test(f.category) && text.length < 80)
  );
}

/** Still nothing to say after enrichment: a generic category with an empty or repeated summary. */
export function isEmptyFiling(f: Filing): boolean {
  const text = f.text.trim().toLowerCase();
  return GENERIC_CATEGORY.test(f.category) && (!text || text === f.category.toLowerCase());
}

/** Replaces weak snippets with the filing's own subject line, read from its PDF. */
async function enrichFromPdfs(filings: Filing[]) {
  const weak = filings.filter((f) => isWeakFiling(f) && /\.pdf($|\?)/i.test(f.url)).slice(0, ENRICH_LIMIT);
  const deadline = Date.now() + ENRICH_BUDGET_MS;
  let next = 0;
  const worker = async () => {
    while (next < weak.length && Date.now() < deadline) {
      const f = weak[next++];
      const subject = await filingSubject(f.url).catch(() => undefined);
      if (subject) f.text = subject;
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, weak.length) }, worker));
}

/**
 * Most relevant to the question first: topic words ("deal", "acquisition") count
 * double, reporting jargon ("results", "board meeting") single; then newest.
 */
export function rankFilings(filings: Filing[], query: string): Filing[] {
  const terms = splitQuery(query);
  const topics = topicTerms(query, filings.flatMap((f) => f.company.aliases));
  const hits = (f: Filing) => {
    const text = `${f.category} ${f.text}`;
    return 2 * termHits(text, topics) + jargonHits(text, terms);
  };
  return [...filings].sort((a, b) => hits(b) - hits(a) || b.time - a.time);
}

export function toResult(f: Filing): EngineResult {
  const name = shortName(f.company.name);
  const summary = f.text.replace(/\.$/, "");
  // Skip the summary when it only repeats the category ("General Updates — General Updates").
  const repeats = summary.toLowerCase() === f.category.toLowerCase();
  const short = summary.length <= 140 ? summary : `${summary.slice(0, 139).replace(/\s+\S*$/, "")}…`;
  const detail = summary && !repeats ? ` — ${short}` : "";
  return {
    url: f.url,
    title: `${name}: ${f.category}${detail}`,
    content: f.text || undefined,
    publishedDate: new Date(f.time).toISOString(),
    author: f.source,
  };
}

export const exchangeFilings: Engine = {
  name: "exchange filings",
  shortcut: "fil",
  categories: ["filings", "news"],
  timeRangeSupport: true,
  // NSE (announcements + meetings) and the BSE feed (about 2.4MB) per company.
  // NSE + the BSE feed, plus reading up to ENRICH_LIMIT filing PDFs on a cold cache.
  timeout: 12000,
  about: "NSE announcements and board meetings (by NSE ticker) and today's BSE announcements (by BSE code)",
  request() {
    return null; // not used: see search()
  },
  response() {
    return [];
  },
  async search(params: SearchParams, ctx: EngineContext) {
    const companies = (await resolveCompanies(params.query)).slice(0, 2);
    if (!companies.length) return [];
    const now = Date.now();
    const from = now - (params.timeRange ? RANGE_DAYS[params.timeRange] : DEFAULT_RANGE_DAYS) * DAY_MS;
    const errors: unknown[] = [];
    const settle = <T>(p: Promise<T>, fallback: T) =>
      p.catch((e) => {
        errors.push(e);
        return fallback;
      });

    const bseFeed = companies.some((c) => c.bse) ? settle(bseToday(ctx), new Map<string, BseItem[]>()) : undefined;
    const perCompany = await Promise.all(
      companies.map(async (c) => {
        // Supplementary: failures here don't fail the engine.
        const screenerPromise = screenerFilings(ctx, c).catch(() => [] as Filing[]);
        const [announcements, meetings] = await Promise.all([
          c.nse
            ? settle(
                getJson(ctx, `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(c.nse)}&from_date=${nseDate(from)}&to_date=${nseDate(now)}`),
                [],
              )
            : [],
          c.nse
            ? settle(getJson(ctx, `https://www.nseindia.com/api/corporate-board-meetings?index=equities&symbol=${encodeURIComponent(c.nse)}`), [])
            : [],
        ]);
        const nse = [
          ...mapNseAnnouncements(Array.isArray(announcements) ? announcements : [], c),
          ...mapUpcomingMeetings(Array.isArray(meetings) ? meetings : [], c, now),
        ];
        const screener = (await screenerPromise).filter((f) => f.time >= from);
        const fromScreener = mergeSummaries(nse, screener);
        const screenerDocs = new Set(screener.map((f) => bseDocId(f.url)).filter(Boolean));
        const bse = (c.bse && bseFeed ? mapBse((await bseFeed).get(c.bse) ?? [], c) : [])
          .filter((f) => f.time >= from && !screenerDocs.has(bseDocId(f.url)));
        return [...nse, ...dropCrossListed([...fromScreener, ...bse], nse)];
      }),
    );
    const filings = perCompany.flat();
    if (!filings.length && errors.length) throw errors[0];
    const ranked = rankFilings(filings, params.query).slice(0, MAX_RESULTS + ENRICH_LIMIT);
    await enrichFromPdfs(ranked.slice(0, MAX_RESULTS + ENRICH_LIMIT));
    // Re-rank: the subject line may now match the question ("dividend", "acquisition").
    return rankFilings(ranked.filter((f) => !isEmptyFiling(f)), params.query).slice(0, MAX_RESULTS).map(toResult);
  },
};
