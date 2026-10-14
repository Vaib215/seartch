// Port of searx/engines/google.py (WML layout requested with Nokia user agents)
// Simplified: locale from a small hard-coded table instead of engine_traits
// ("all" sends hl=en rather than the traits' "ZZ"); no TLS impersonation
// (Python uses curl_cffi "chrome99_android"); suggestions dropped; max_page (50)
// enforced in response() since requests can't be skipped.

import { extractText, parseHtml } from "../html";
import { EngineCaptcha, type Engine, type EngineResponse, type EngineResult, type SearchParams } from "../types";

const MAX_PAGE = 50;
const TIME_RANGE: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
const FILTER_MAPPING: Record<number, string> = { 0: "off", 1: "medium", 2: "high" };

// https://github.com/searxng/searxng/issues/6359
export const NOKIA_USERAGENTS = [
  "Nokia7610/2.0 (5.0509.0) SymbianOS/7.0s Series60/2.1 Profile/MIDP-2.0 Configuration/CLDC-1.0",
  "Nokia7610/2.0 (7.0642.0) SymbianOS/7.0s Series60/2.1 Profile/MIDP-2.0 Configuration/CLDC-1.0",
  "Nokia6230/2.0 (05.50) Profile/MIDP-2.0 Configuration/CLDC-1.1",
  "Nokia6230i/2.0 (03.80) Profile/MIDP-2.0 Configuration/CLDC-1.1",
  "Nokia6280/2.0 (03.60) Profile/MIDP-2.0 Configuration/CLDC-1.1",
  "NokiaN72/2.0617.1.0.3 Series60/2.8 Profile/MIDP-2.0 Configuration/CLDC-1.1",
];

/** get_google_info(): hl / lr / cr / ie / oe params. */
export function googleInfo(language: string): Record<string, string> {
  const all = !language || language === "all";
  const [lang, cc] = all ? ["en", undefined] : language.split("-");
  let langCode = lang.toLowerCase();
  // traits alias: zh -> lang_zh-CN; zh-TW / zh-HK keep their region
  if (langCode === "zh") langCode = cc && ["TW", "HK"].includes(cc.toUpperCase()) ? "zh-TW" : "zh-CN";
  return {
    hl: langCode,
    lr: all ? "" : `lang_${langCode}`,
    // cr only when a region is given in the locale (searxng#2672)
    cr: cc ? `country${cc.toUpperCase()}` : "",
    ie: "utf8",
    oe: "utf8",
  };
}

/** Google's bot-protection responses (CAPTCHA / sorry pages). */
export function detectGoogleSorry(resp: EngineResponse) {
  const u = new URL(resp.url);
  if (u.hostname === "sorry.google.com" || u.pathname.startsWith("/sorry")) throw new EngineCaptcha("Google sorry page");
  if (resp.status === 302) throw new EngineCaptcha("Google redirect (sorry page)");
  if (resp.text.length < 2000 && resp.text.includes("/sorry/")) throw new EngineCaptcha("Google sorry page");
}

/** Remove redirector from url. */
export function unwrapGoogleUrl(raw: string): string {
  if (raw.startsWith("/url?q=")) {
    const s = raw.slice(7).split("&sa=U")[0];
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }
  return raw;
}

export const google: Engine = {
  name: "google",
  maxPage: MAX_PAGE,
  shortcut: "go",
  categories: ["general"],
  disabled: true,
  paging: true,
  timeRangeSupport: true,
  safesearch: true,
  request(params: SearchParams) {
    const start = (params.pageno - 1) * 10;
    const args: Record<string, string> = { q: params.query, sca_esv: "1", ...googleInfo(params.language) };
    if (start) args.start = String(start);
    if (params.timeRange && TIME_RANGE[params.timeRange]) args.tbs = `qdr:${TIME_RANGE[params.timeRange]}`;
    if (params.safesearch) args.safe = FILTER_MAPPING[params.safesearch];
    return {
      url: `https://www.google.com/wml/search?${new URLSearchParams(args)}`,
      headers: {
        "user-agent": NOKIA_USERAGENTS[Math.floor(Math.random() * NOKIA_USERAGENTS.length)],
        accept: "*/*",
      },
      cookies: { CONSENT: "YES+" },
      // SearXNG doesn't follow redirects: a 302 here is the sorry page.
      redirect: "manual",
    };
  },
  response(resp, params) {
    detectGoogleSorry(resp);
    if (params.pageno > MAX_PAGE) return [];
    let text = resp.text;
    if (text.trimStart().startsWith("<?xml")) text = text.split("?>").slice(1).join("?>");
    const dom = parseHtml(text);
    const results: EngineResult[] = [];
    for (const result of dom.querySelectorAll('div[class*="zMzFAb"]')) {
      const titleTag = result.querySelector('a[class*="fuLhoc"] span[class*="CVA68e"]');
      if (!titleTag) continue; // not one of the common google result sections
      const title = extractText(titleTag);
      const rawUrl = result.querySelector('a[class*="fuLhoc"]')?.getAttribute("href");
      if (rawUrl == null) continue;
      const content = result
        .querySelectorAll('div[class*="taTFJ"] span[class*="FrIlee"]')
        .map((e) => extractText(e))
        .join(" ")
        .trim();
      const thumbnail = result.querySelector('img[src*="encrypted-tbn"]')?.getAttribute("src");
      results.push({ url: unwrapGoogleUrl(rawUrl), title, content, ...(thumbnail ? { thumbnail } : {}) });
    }
    return results;
  },
};
