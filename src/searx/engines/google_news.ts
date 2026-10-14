// Google News (not in SearXNG's default set; SearXNG's google_news scrapes the
// HTML page, which answers datacenter IPs with the /sorry/ CAPTCHA). The RSS
// search feed is not blocked, but its links are opaque
// https://news.google.com/rss/articles/CBMi... redirects, so each one is
// resolved to the publisher URL:
//
//   1. GET /rss/articles/<id> → read data-n-a-ts / data-n-a-sg (timestamp and
//      signature; the signature is per article, ~120KB gzipped page).
//   2. POST /_/DotsSplashUi/data/batchexecute with one Fbv4je "garturlreq" per
//      article, all in a single call → "garturlres" with the publisher URL.
//
// A query costs 1 (RSS) + up to MAX_RESOLVE (pages) + 1 (batchexecute)
// requests; ids resolved before are cached per isolate and cost nothing.
// Pre-2024 ids embedded the URL in base64 protobuf; those decode offline.

import { cleanText } from "../../util";
import { CHROME_UA } from "../http";
import {
  type Engine,
  type EngineContext,
  type EngineResponse,
  type EngineResult,
  type SearchParams,
  type TimeRange,
  EngineAccessDenied,
  EngineCaptcha,
  EngineError,
  EngineTooManyRequests,
} from "../types";
import { type FeedItem, parseRss } from "./india_news";

const BASE = "https://news.google.com";
const WHEN: Record<TimeRange, string> = { day: "1d", week: "7d", month: "30d", quarter: "90d", year: "1y" };
const TIME_RANGE_MS: Record<TimeRange, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  quarter: 91 * 86_400_000,
  year: 365 * 86_400_000,
};

/** Articles resolved over the network per query. */
const MAX_RESOLVE = 10;
/** Article pages fetched at once (the Worker has 6 connections, shared with other engines). */
const PAGE_CONCURRENCY = 4;
/** Signatures not in hand by then are dropped so the batchexecute call fits in the timeout. */
const PAGE_BUDGET_MS = 5000;
/** Results returned per query, counting cached and offline-decoded ones. */
const MAX_RESULTS = 20;
const CACHE_MAX = 5000;

// --- locale ------------------------------------------------------------------

export interface Edition {
  hl: string;
  gl: string;
  ceid: string;
}

// "all" defaults to the Indian edition: this deployment serves Indian stock research.
const DEFAULT_EDITION: Edition = { hl: "en-IN", gl: "IN", ceid: "IN:en" };
// Google News editions whose ceid language isn't the plain language code.
const CEID_LANG: Record<string, string> = { "pt-BR": "pt-419", "es-US": "es-419", "zh-CN": "zh-Hans", "zh-TW": "zh-Hant", "zh-HK": "zh-Hant" };
// Default region for a bare language code (en → India, matching DEFAULT_EDITION).
const LANG_REGION: Record<string, string> = { en: "IN", hi: "IN", bn: "IN", ta: "IN", te: "IN", mr: "IN", ml: "IN", gu: "IN", kn: "IN", pa: "IN" };

export function edition(language: string): Edition {
  const [rawLang, rawRegion] = language.split("-");
  const lang = rawLang?.toLowerCase();
  if (!lang || language === "all") return DEFAULT_EDITION;
  const region = (rawRegion ?? LANG_REGION[lang] ?? lang).toUpperCase();
  const locale = `${lang}-${region}`;
  // Google uses region-qualified hl for English, Portuguese and Chinese editions only.
  const hl = ["en", "pt", "zh"].includes(lang) ? locale : lang;
  return { hl, gl: region, ceid: `${region}:${CEID_LANG[locale] ?? lang}` };
}

export function rssUrl(params: SearchParams): string {
  const ed = edition(params.language);
  const q = params.timeRange ? `${params.query} when:${WHEN[params.timeRange]}` : params.query;
  const u = new URL(`${BASE}/rss/search`);
  u.searchParams.set("q", q);
  u.searchParams.set("hl", ed.hl);
  u.searchParams.set("gl", ed.gl);
  u.searchParams.set("ceid", ed.ceid);
  return u.href;
}

// --- RSS items -----------------------------------------------------------------

export interface NewsItem {
  id: string;
  title: string;
  publisher?: string;
  date?: string;
}

/** Google appends " - <Publisher>" to every title; split it off. */
export function splitTitle(title: string, source?: string): { title: string; publisher?: string } {
  if (source && title.endsWith(` - ${source}`)) {
    return { title: title.slice(0, -(source.length + 3)).trim(), publisher: source };
  }
  const i = title.lastIndexOf(" - ");
  if (i > 0) return { title: title.slice(0, i).trim(), publisher: source ?? title.slice(i + 3).trim() };
  return { title, publisher: source };
}

/** The article id from a news.google.com/rss/articles/<id>?oc=5 link. */
export function articleId(link: string): string | undefined {
  const m = /^https:\/\/news\.google\.com\/(?:rss\/|__i\/rss\/rd\/)?articles\/([A-Za-z0-9_-]+)/.exec(link);
  return m?.[1];
}

export function parseFeed(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const it of parseRss(xml) as FeedItem[]) {
    const id = articleId(it.link);
    if (!id) continue;
    const { title, publisher } = splitTitle(it.title, it.source);
    if (title) items.push({ id, title, publisher, date: it.date });
  }
  return items;
}

export function withinRange<T extends { date?: string }>(items: T[], timeRange?: TimeRange, now = Date.now()): T[] {
  if (!timeRange) return items;
  const cutoff = now - TIME_RANGE_MS[timeRange];
  return items.filter((it) => !it.date || Date.parse(it.date) >= cutoff);
}

// --- id decoding -----------------------------------------------------------------

function base64UrlBytes(s: string): Uint8Array | undefined {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Old-style ids are a protobuf whose field 4 is the publisher URL
 * (08 13 22 <len> "https://..."). Current ids carry an opaque "AU_yqL..." token
 * there instead; those return undefined and need the network.
 */
export function decodeOfflineId(id: string): string | undefined {
  const b = base64UrlBytes(id);
  if (!b || b[0] !== 0x08 || b[2] !== 0x22) return undefined;
  let len = 0;
  let shift = 0;
  let i = 3;
  for (; i < b.length; i++) {
    len |= (b[i] & 0x7f) << shift;
    shift += 7;
    if (!(b[i] & 0x80)) break;
  }
  const start = i + 1;
  if (start + len > b.length) return undefined;
  const value = new TextDecoder().decode(b.subarray(start, start + len));
  return /^https?:\/\/\S+$/.test(value) ? value : undefined;
}

export interface ArticleSignature {
  id: string;
  ts: number;
  sig: string;
}

/** data-n-a-ts / data-n-a-sg from an article page. */
export function parseArticlePage(html: string, id: string): ArticleSignature | undefined {
  const ts = /data-n-a-ts="(\d+)"/.exec(html)?.[1];
  const sig = /data-n-a-sg="([^"]+)"/.exec(html)?.[1];
  return ts && sig ? { id, ts: Number(ts), sig } : undefined;
}

/** The f.req form field for a batchexecute call with one Fbv4je request per article. */
export function batchRequestBody(sigs: ArticleSignature[], ed: Edition = DEFAULT_EDITION): string {
  const calls = sigs.map((s, i) => [
    "Fbv4je",
    JSON.stringify([
      "garturlreq",
      [["X", "X", ["X", "X"], null, null, 1, 1, ed.ceid, null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      s.id,
      s.ts,
      s.sig,
    ]),
    null,
    String(i + 1),
  ]);
  return JSON.stringify([calls]);
}

/**
 * batchexecute answers `)]}'` then JSON, either one array or length-prefixed
 * chunks. Entries are ["wrb.fr", "Fbv4je", "<json payload>", ..., "<call index>"]
 * and arrive in any order. Returns call index (1-based) → publisher URL.
 */
export function parseBatchResponse(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const body = text.replace(/^\)\]\}'\s*/, "");
  const chunks: unknown[] = [];
  try {
    chunks.push(JSON.parse(body));
  } catch {
    for (const line of body.split("\n")) {
      if (!line.startsWith("[")) continue;
      try {
        chunks.push(JSON.parse(line));
      } catch {
        // not a JSON line (length prefix or truncated chunk)
      }
    }
  }
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    for (const entry of chunk) {
      if (!Array.isArray(entry) || entry[0] !== "wrb.fr" || entry[1] !== "Fbv4je" || typeof entry[2] !== "string") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(entry[2]);
      } catch {
        continue;
      }
      const index = Number(entry[6] === "generic" ? 1 : entry[6]);
      if (Array.isArray(payload) && payload[0] === "garturlres" && typeof payload[1] === "string" && /^https?:\/\//.test(payload[1]) && index > 0) {
        out.set(index, payload[1]);
      }
    }
  }
  return out;
}

// --- blocking --------------------------------------------------------------------

/** Google's sorry/consent interstitials and rate limits, for any news.google.com response. */
export function checkBlocked(status: number, url: string, text: string): void {
  let host = "";
  let path = "";
  try {
    ({ hostname: host, pathname: path } = new URL(url));
  } catch {
    // keep empty
  }
  if (host === "sorry.google.com" || path.startsWith("/sorry") || (status >= 300 && text.length < 4000 && text.includes("/sorry/"))) {
    throw new EngineCaptcha("Google sorry page");
  }
  if (host === "consent.google.com" || (text.length < 200_000 && /consent\.google\.com\/(?:ml|save|s\?)/.test(text) && !/<rss[\s>]/.test(text))) {
    throw new EngineAccessDenied("Google consent page");
  }
  if (status === 429) throw new EngineTooManyRequests();
  if (status === 403) throw new EngineAccessDenied("HTTP 403");
  if (status >= 400) throw new EngineError("http", `HTTP ${status}`);
}

// --- resolution ----------------------------------------------------------------------

// id → publisher URL, per isolate. Map order doubles as a cheap FIFO for eviction.
const resolved = new Map<string, string>();

function remember(id: string, url: string) {
  if (resolved.size >= CACHE_MAX) resolved.delete(resolved.keys().next().value!);
  resolved.set(id, url);
}

/** For tests. */
export function clearResolveCache() {
  resolved.clear();
}

const HEADERS = { "user-agent": CHROME_UA, "accept-language": "en-US,en;q=0.9" };
const COOKIES = "CONSENT=YES+";

async function fetchSignature(ctx: EngineContext, id: string, ed: Edition): Promise<ArticleSignature | undefined> {
  // Passing the edition up front avoids a 302 that only appends it.
  const url = `${BASE}/rss/articles/${id}?hl=${encodeURIComponent(ed.hl)}&gl=${ed.gl}&ceid=${encodeURIComponent(ed.ceid)}`;
  const res = await ctx.fetch(url, { headers: { ...HEADERS, accept: "text/html", cookie: COOKIES } });
  const text = await res.text();
  checkBlocked(res.status, res.url || url, text);
  return parseArticlePage(text, id);
}

async function batchDecode(ctx: EngineContext, sigs: ArticleSignature[], ed: Edition): Promise<Map<string, string>> {
  const url = `${BASE}/_/DotsSplashUi/data/batchexecute`;
  const res = await ctx.fetch(url, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/x-www-form-urlencoded;charset=UTF-8", cookie: COOKIES },
    body: new URLSearchParams({ "f.req": batchRequestBody(sigs, ed) }),
  });
  const text = await res.text();
  checkBlocked(res.status, res.url || url, text);
  const byIndex = parseBatchResponse(text);
  const out = new Map<string, string>();
  sigs.forEach((s, i) => {
    const u = byIndex.get(i + 1);
    if (u) out.set(s.id, u);
  });
  return out;
}

/**
 * Resolves ids to publisher URLs: cache and offline decoding first, then
 * article pages (concurrency-limited, time-boxed) and one batchexecute call.
 * Ids that fail are simply missing from the result. Blocking errors are
 * rethrown only when nothing at all could be resolved.
 */
export async function resolveIds(ctx: EngineContext, ids: string[], ed: Edition): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pending: string[] = [];
  for (const id of ids) {
    const hit = resolved.get(id) ?? decodeOfflineId(id);
    if (hit) out.set(id, hit);
    else if (!pending.includes(id)) pending.push(id);
  }
  if (!pending.length) return out;

  const deadline = Date.now() + PAGE_BUDGET_MS;
  const sigs: ArticleSignature[] = [];
  let blocked: unknown;
  let next = 0;
  const worker = async () => {
    while (next < pending.length && !blocked && Date.now() < deadline) {
      const id = pending[next++];
      try {
        const left = deadline - Date.now();
        let timer: Parameters<typeof clearTimeout>[0];
        const sig = await Promise.race([
          fetchSignature(ctx, id, ed),
          new Promise<undefined>((r) => (timer = setTimeout(r, left))),
        ]).finally(() => clearTimeout(timer));
        if (sig) sigs.push(sig);
      } catch (e) {
        if (e instanceof EngineError && e.kind !== "http") blocked = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, pending.length) }, worker));

  if (sigs.length) {
    try {
      for (const [id, url] of await batchDecode(ctx, sigs, ed)) {
        remember(id, url);
        out.set(id, url);
      }
    } catch (e) {
      blocked ??= e;
    }
  }
  if (!out.size && blocked) throw blocked;
  return out;
}

// --- engine ---------------------------------------------------------------------------

// Google's feed mixes in social reposts, syndicated copies and stock-quote pages;
// none of them is a fetchable article. Publisher names are checked before spending
// a resolve, URLs after.
const NOISE_PUBLISHERS = /^(facebook|linkedin|youtube|instagram|x|twitter|threads|msn|yahoo finance)$/i;
const NOISE_URL = /^https?:\/\/([^/]+\.)?(facebook|linkedin|youtube|instagram|twitter|x|threads|msn)\.(com|net)\/|finance\.yahoo\.com\/quote|scanx\.trade/i;

export const googleNews: Engine = {
  name: "google news",
  shortcut: "gn",
  categories: ["news"],
  timeRangeSupport: true,
  // RSS + article pages (4 at a time) + one batchexecute call.
  timeout: 8000,
  raiseForHttpError: false,
  request(params) {
    return {
      url: rssUrl(params),
      headers: { accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8" },
      cookies: { CONSENT: "YES+" },
    };
  },
  async response(resp: EngineResponse, params, ctx) {
    checkBlocked(resp.status, resp.url, resp.text);
    if (!/<rss[\s>]/.test(resp.text)) {
      const sample = cleanText(resp.text.replace(/<[^>]+>/g, " ")).slice(0, 160);
      throw new EngineError("parse", `Google News did not return RSS${sample ? `: ${sample}` : ""}`);
    }
    const items = withinRange(parseFeed(resp.text), params.timeRange);

    // Everything already known is free; spend the network budget on the first
    // MAX_RESOLVE items that need it, in Google's (relevance) order.
    const picked: NewsItem[] = [];
    let needNetwork = 0;
    for (const it of items) {
      if (picked.length >= MAX_RESULTS) break;
      if (it.publisher && NOISE_PUBLISHERS.test(it.publisher)) continue;
      const free = resolved.has(it.id) || decodeOfflineId(it.id) !== undefined;
      if (!free) {
        if (needNetwork >= MAX_RESOLVE) continue;
        needNetwork++;
      }
      picked.push(it);
    }
    const urls = await resolveIds(ctx, picked.map((it) => it.id), edition(params.language));

    const results: EngineResult[] = [];
    for (const it of picked) {
      const url = urls.get(it.id);
      if (!url || NOISE_URL.test(url)) continue;
      results.push({ url, title: it.title, publishedDate: it.date, author: it.publisher });
    }
    return results;
  },
};
