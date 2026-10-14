// Port of searx/engines/duckduckgo.py
// Simplified: region comes from a small hard-coded locale map instead of
// engine_traits; every "!word" is quoted (Python only quotes known DDG bangs);
// the zero-click Answer is dropped (no answer result type here); the vqd cache
// is per-isolate (module map) instead of SearXNG's SQLite EngineCache.

import { extractText, parseHtml } from "../html";
import { type Engine, EngineCaptcha } from "../types";

const DDG_URL = "https://html.duckduckgo.com/html/";
const VQD_TTL_MS = 3600_000;

const TIME_RANGE: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };

// SearXNG locale -> DDG region (subset of engine_traits.json "duckduckgo".regions).
// A plain language ("de") maps to its home region ("de-DE", "en" -> "en-US") as
// locales.get_engine_locale does; anything unknown falls back to "wt-wt".
const REGIONS: Record<string, string> = {
  "en-US": "us-en", "en-GB": "uk-en", "en-AU": "au-en", "en-CA": "ca-en", "en-IN": "in-en",
  "en-IE": "ie-en", "en-NZ": "nz-en", "en-ZA": "za-en", "en-SG": "sg-en",
  "de-DE": "de-de", "de-AT": "at-de", "de-CH": "ch-de",
  "fr-FR": "fr-fr", "fr-BE": "be-fr", "fr-CA": "ca-fr", "fr-CH": "ch-fr",
  "es-ES": "es-es", "es-MX": "mx-es", "es-AR": "ar-es", "es-US": "us-es",
  "it-IT": "it-it", "nl-NL": "nl-nl", "pt-BR": "br-pt", "pt-PT": "pt-pt",
  "ja-JP": "jp-jp", "ko-KR": "kr-kr", "zh-CN": "cn-zh", "zh-TW": "tw-tzh", "zh-HK": "hk-tzh",
  "ru-RU": "ru-ru", "pl-PL": "pl-pl", "sv-SE": "se-sv", "tr-TR": "tr-tr",
};

function region(language: string): string {
  if (language === "all") return "wt-wt";
  return REGIONS[language] ?? REGIONS[homeLocale(language)] ?? "wt-wt";
}

function homeLocale(lang: string): string {
  return `${lang}-${lang === "en" ? "US" : lang.toUpperCase()}`;
}

/** quote_ddg_bangs(): quote "!bang" words so DDG doesn't redirect. */
export function quoteDdgBangs(query: string): string {
  return query
    .split(/\s+/)
    .filter((w) => w.trim())
    .map((w) => (w.startsWith("!") && w.length > 1 ? `'${w}'` : w))
    .join(" ");
}

// The vqd value is tied to query + User-Agent; our UA is static (http.ts default).
// response() gets no ctx, so the vqd lives in a module-level (per-isolate) map.
const vqdStore = new Map<string, { value: string; expires: number }>();

function storeVqd(query: string, value: string) {
  vqdStore.set(query, { value, expires: Date.now() + VQD_TTL_MS });
}

function getVqd(query: string): string {
  const hit = vqdStore.get(query);
  return hit && hit.expires > Date.now() ? hit.value : "";
}

export const duckduckgo: Engine = {
  name: "duckduckgo",
  shortcut: "ddg",
  categories: ["general"],
  paging: true,
  timeRangeSupport: true,
  safesearch: true,
  // Captcha (challenge-form) arrives as HTTP 200; a 303 means "no results".
  request(params) {
    if (params.query.length >= 500) {
      return null; // Python: params["url"] = None
    }
    const query = quoteDdgBangs(params.query);
    const kl = region(params.language);

    const headers: Record<string, string> = {
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      Referer: DDG_URL,
    };
    if (params.language !== "all") {
      const base = params.language.split("-")[0];
      headers["Accept-Language"] = params.language === base ? base : `${params.language},${base};q=0.7`;
    }

    const form: Record<string, string> = { q: query };
    const cookies: Record<string, string> = {};

    if (params.pageno === 1) {
      form.b = "";
    } else {
      const vqd = getVqd(query);
      if (!vqd) {
        // Requesting follow-up pages without vqd looks like a bot to DDG.
        throw new EngineCaptcha(`VQD missed (page: ${params.pageno}, locale: ${params.language})`, 0);
      }
      form.vqd = vqd;
      if (params.language.startsWith("zh")) {
        // Python skips: those locales have no "next page" and DDG answers 403.
        return null;
      }
      form.nextParams = "";
      form.api = "d.js";
      form.o = "json";
      form.v = "l";
      const offset = 10 + (params.pageno - 2) * 15;
      form.dc = String(offset + 1);
      form.s = String(offset);
    }

    form.kl = kl;
    if (kl !== "wt-wt") cookies.kl = kl;

    const df = params.timeRange ? TIME_RANGE[params.timeRange] : "";
    if (df) {
      form.df = df;
      cookies.df = df;
    }

    return { url: DDG_URL, method: "POST", headers, form, cookies, redirect: "manual" };
  },

  response(resp, params) {
    if (resp.status === 303) return [];
    // Checked on the raw text: node-html-parser misses form#challenge-form on the
    // real anomaly page (served with HTTP 202).
    if (/id="challenge-form"|anomaly-modal/.test(resp.text)) {
      throw new EngineCaptcha(`CAPTCHA (${region(params.language)})`, 0);
    }
    const doc = parseHtml(resp.text);

    const vqd = doc.querySelector('input[name="vqd"]')?.getAttribute("value");
    if (vqd) storeVqd(quoteDdgBangs(params.query), vqd);

    const results = [];
    for (const div of doc.querySelectorAll("div#links > div.web-result")) {
      const a = div.querySelector("h2 a");
      const href = a?.getAttribute("href");
      if (!a || !href) continue;
      results.push({
        url: href,
        title: extractText(a),
        content: extractText(div.querySelector("a.result__snippet")),
      });
    }
    return results;
  },
};
