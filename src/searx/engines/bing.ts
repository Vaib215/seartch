// Port of searx/engines/bing.py
// Simplified: engine_traits region lookup replaced by a small hard-coded
// language -> market table; "all" maps to Bing's "clear" (no locale params).

import { extractText, parseHtml } from "../html";
import type { Engine, EngineResult, SearchParams } from "../types";

const BASE_URL = "https://www.bing.com";

const SAFESEARCH_MAP: Record<number, string> = { 0: "off", 1: "moderate", 2: "strict" };

/** Default market for a bare language code (what traits.get_region would pick). */
const DEFAULT_MARKET: Record<string, string> = {
  en: "en-us",
  de: "de-de",
  fr: "fr-fr",
  es: "es-es",
  it: "it-it",
  nl: "nl-nl",
  pt: "pt-br",
  ru: "ru-ru",
  ja: "ja-jp",
  ko: "ko-kr",
  zh: "zh-cn",
  pl: "pl-pl",
  sv: "sv-se",
  tr: "tr-tr",
};

/** SearXNG locale ("all", "en", "en-US") -> Bing market code ("en-us") or undefined for "clear". */
export function bingMarket(language: string): string | undefined {
  if (!language || language === "all") return undefined;
  const [lang, cc] = language.toLowerCase().split("-");
  if (cc) return `${lang}-${cc}`;
  return DEFAULT_MARKET[lang] ?? lang;
}

function decodeBase64Url(s: string): string {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Unwrap Bing's https://www.bing.com/ck/a?...&u=a1<base64url> click-tracking links. */
export function unwrapBingUrl(href: string): string {
  if (!href.startsWith("https://www.bing.com/ck/a?")) return href;
  const u = new URL(href).searchParams.get("u");
  if (u && u.startsWith("a1")) {
    try {
      return decodeBase64Url(u.slice(2));
    } catch {
      return href;
    }
  }
  return href;
}

export const bing: Engine = {
  name: "bing",
  shortcut: "bi",
  categories: ["general"],
  disabled: true,
  safesearch: true,
  // bing.py: paging and time-range are not supported (they depend on JavaScript).
  paging: false,
  timeRangeSupport: false,
  request(params: SearchParams) {
    const url = new URL(`${BASE_URL}/search`);
    url.searchParams.set("q", params.query);
    url.searchParams.set("adlt", SAFESEARCH_MAP[params.safesearch] ?? "off");
    const region = bingMarket(params.language);
    if (region && region !== "clear") {
      const [lang, cc] = region.split("-");
      url.searchParams.set("setlang", lang);
      if (cc && !["us", "cn", "ru"].includes(cc)) url.searchParams.set("cc", cc);
    }
    return { url: url.href };
  },
  response(resp) {
    const dom = parseHtml(resp.text);
    const results: EngineResult[] = [];
    for (const item of dom.querySelectorAll('ol#b_results > li[class*="b_algo"]')) {
      const link = item.querySelector("h2 a");
      if (!link) continue;
      let href = link.getAttribute("href") ?? "";
      const title = extractText(link);
      if (!href || !title) continue;
      href = unwrapBingUrl(href);

      const ps = item.querySelectorAll("p");
      for (const p of ps) for (const icon of p.querySelectorAll("span.algoSlug_icon")) icon.remove();
      const content = ps.map((p) => extractText(p)).filter(Boolean).join(" ");

      results.push({ url: href, title, content });
    }
    return results;
  },
};
