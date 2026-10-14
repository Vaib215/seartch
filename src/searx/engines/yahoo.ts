// Port of searx/engines/yahoo.py
// Simplified: suggestions (AlsoTry) are dropped (no suggestion result type);
// the YBV cookie is cached in a module-level variable instead of EngineCache.

import { CHROME_UA } from "../http";
import { extractText, htmlToText, parseHtml } from "../html";
import { EngineError, type Engine, type EngineResponse, type EngineResult, type SearchParams } from "../types";

const TIME_RANGE: Record<string, string> = { day: "d", week: "w", month: "m" };
const SAFESEARCH: Record<number, string> = { 0: "p", 1: "i", 2: "r" };

const REGION2DOMAIN: Record<string, string> = {
  CO: "co.search.yahoo.com",
  TH: "th.search.yahoo.com",
  VE: "ve.search.yahoo.com",
  CL: "cl.search.yahoo.com",
  PE: "pe.search.yahoo.com",
  CA: "ca.search.yahoo.com",
  DE: "de.search.yahoo.com",
  FR: "fr.search.yahoo.com",
  GB: "uk.search.yahoo.com",
  UK: "uk.search.yahoo.com",
  BR: "br.search.yahoo.com",
  IN: "in.search.yahoo.com",
  ES: "espanol.search.yahoo.com",
  PH: "ph.search.yahoo.com",
  AR: "ar.search.yahoo.com",
  MX: "mx.search.yahoo.com",
  SG: "sg.search.yahoo.com",
  AU: "au.search.yahoo.com",
  NZ: "nz.search.yahoo.com",
  IE: "ie.search.yahoo.com",
  ZA: "za.search.yahoo.com",
  US: "search.yahoo.com",
  IT: "it.search.yahoo.com",
  NL: "nl.search.yahoo.com",
  BE: "be.search.yahoo.com",
  CH: "ch.search.yahoo.com",
  AT: "at.search.yahoo.com",
  SE: "se.search.yahoo.com",
  NO: "no.search.yahoo.com",
  DK: "dk.search.yahoo.com",
  FI: "fi.search.yahoo.com",
  GR: "gr.search.yahoo.com",
  TR: "tr.search.yahoo.com",
  MY: "malaysia.search.yahoo.com",
  ID: "id.search.yahoo.com",
  VN: "vn.search.yahoo.com",
  PL: "pl.search.yahoo.com",
  RO: "ro.search.yahoo.com",
};

const YAHOO_LANGUAGES: Record<string, string> = {
  all: "any",
  ...Object.fromEntries(
    "ar bg cs da de el en es et fi fr he hr hu it ja ko lt lv nl no pl pt ro ru sk sl sv th tr".split(" ").map((l) => [l, l]),
  ),
  zh: "zh_chs",
};

/** Tracking pixel -> gif -> (optional) geo redirect i.e. au.search.yahoo.com -> 200 */
const YBV_HOPS = 4;

/** Stand-in for EngineCache("yahoo"): the YBV bot-detection cookie, kept 24h. */
let ybvCache: { value: string; expires: number } | undefined;

function cachedYbv(): string | undefined {
  if (ybvCache && ybvCache.expires > Date.now()) return ybvCache.value;
  return undefined;
}

function buildCookies(params: SearchParams): Record<string, string> {
  const lang = YAHOO_LANGUAGES[params.language.split("-")[0].toLowerCase()] ?? "any";
  const sB = new URLSearchParams({
    v: "1",
    vm: SAFESEARCH[params.safesearch] ?? "p",
    fl: "1",
    vl: `lang_${lang}`,
    pn: "10",
    rw: "new",
    userset: "1",
  }).toString();
  const cookies: Record<string, string> = { sB };
  const ybv = cachedYbv();
  if (ybv) cookies.YBV = ybv;
  return cookies;
}

/** Remove yahoo-specific tracking-url (r.search.yahoo.com/.../RU=<url>/RK=.../RS=...). */
export function parseYahooUrl(urlString: string): string {
  const start = urlString.indexOf("http", urlString.indexOf("/RU=") + 1);
  const endpositions = ["/RS", "/RK"].map((e) => urlString.lastIndexOf(e)).filter((p) => p > -1);
  if (start === 0 || start === -1 || endpositions.length === 0) return urlString;
  const raw = urlString.slice(start, Math.min(...endpositions));
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function setCookieValue(headers: Headers, name: string): string | undefined {
  const all = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
  for (const c of all) {
    const m = c.match(new RegExp(`(?:^|[;,]\\s*)${name}=([^;]*)`));
    if (m) return m[1];
  }
  return undefined;
}

function allSetCookies(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const all = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const c of all) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
    if (m && m[2] !== "" && m[2].toLowerCase() !== "deleted") out[m[1]] = m[2];
  }
  return out;
}

/**
 * yahoo.py _yahoo_html: Yahoo answers a cookie-less search with a 307 to a
 * tracking gif which sets YBV and redirects back. Follow those hops ourselves
 * (fetch has no cookie jar) and cache a v0.2 YBV for a day.
 */
async function yahooHtml(resp: EngineResponse, params: SearchParams): Promise<EngineResponse> {
  const cookies = buildCookies(params);
  for (let i = 0; i < YBV_HOPS; i++) {
    // Keep every cookie set along the way, like a browser's jar; some edges
    // only accept YBV together with the other cookies issued in the same hop.
    Object.assign(cookies, allSetCookies(resp.headers));
    const ybv = setCookieValue(resp.headers, "YBV");
    if (ybv) {
      cookies.YBV = ybv;
      if (ybv.startsWith("v0.2")) ybvCache = { value: ybv, expires: Date.now() + 86_400_000 };
    }
    if (resp.status === 200) return resp;
    const loc = resp.headers.get("location");
    if (![302, 307].includes(resp.status) || !loc) return resp;
    const url = new URL(loc, resp.url).href;
    const res = await fetch(url, {
      headers: {
        "user-agent": CHROME_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    resp = { status: res.status, url, headers: res.headers, text, json: () => JSON.parse(text) };
  }
  return resp;
}

export const yahoo: Engine = {
  name: "yahoo",
  shortcut: "yh",
  categories: ["general"],
  disabled: true,
  paging: true,
  timeRangeSupport: true,
  safesearch: true,
  request(params) {
    const parts = params.language.split("-");
    const url = new URL("https://search.yahoo.com/search");
    url.searchParams.set("p", params.query);
    if (params.timeRange && TIME_RANGE[params.timeRange]) url.searchParams.set("btf", TIME_RANGE[params.timeRange]);
    if (params.pageno === 1) {
      url.searchParams.set("iscqry", "");
    } else {
      url.searchParams.set("b", String(params.pageno * 7 + 1));
      url.searchParams.set("pz", "7");
      url.searchParams.set("bct", "0");
      url.searchParams.set("xargs", "0");
    }
    const region = parts.length > 1 ? parts[parts.length - 1].toUpperCase() : "";
    url.hostname = REGION2DOMAIN[region] ?? "search.yahoo.com";
    // We must see the 307 to the YBV tracking gif ourselves.
    return { url: url.href, cookies: buildCookies(params), redirect: "manual" };
  },
  async response(resp, params) {
    resp = await yahooHtml(resp, params);
    if (resp.status !== 200) {
      const loc = resp.headers.get("location");
      throw new EngineError("http", `HTTP ${resp.status}${loc ? ` -> ${loc.slice(0, 120)}` : ""}`);
    }
    const dom = parseHtml(resp.text);
    const results: EngineResult[] = [];
    for (const result of dom.querySelectorAll('div[class*="algo-sr"]')) {
      const href = result.querySelector('div[class*="compTitle"] a[href]')?.getAttribute("href");
      if (href == null) continue;
      const url = parseYahooUrl(href);
      let title = result.querySelector("h3 a[aria-label]")?.getAttribute("aria-label") ?? "";
      if (!title) title = extractText(result.querySelector("a > h3"));
      if (!title) continue;
      const content = extractText(result.querySelector('div[class*="compText"]'));
      // title sometimes contains HTML tags, see searxng#3790
      results.push({ url, title: htmlToText(title), content: htmlToText(content) });
    }
    return results;
  },
};
