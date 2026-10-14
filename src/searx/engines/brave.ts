// Port of searx/engines/brave.py (brave_category "search" only)
// Simplified: web results only (no secondary videos / suggestions, no images/
// news/videos/goggles categories); region and ui_lang come from small
// hard-coded maps instead of engine_traits.
// Added: Brave's captcha page (served as HTTP 429) is reported as EngineCaptcha.

import { htmlToText } from "../html";
import { raiseForHttpError } from "../http";
import { type Engine, type EngineResult, EngineCaptcha, EngineError } from "../types";

const BASE_URL = "https://search.brave.com/";

const SAFESEARCH: Record<number, string> = { 2: "strict", 1: "moderate", 0: "off" };
const TIME_RANGE: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

// SearXNG locale -> Brave country (traits.regions, subset).
const REGIONS: Record<string, string> = {
  "en-US": "us", "en-GB": "gb", "en-CA": "ca", "en-AU": "au", "en-IN": "in", "en-NZ": "nz", "en-ZA": "za",
  "de-DE": "de", "de-AT": "at", "de-CH": "ch", "fr-FR": "fr", "fr-CA": "ca", "fr-BE": "be",
  "es-ES": "es", "es-MX": "mx", "es-AR": "ar", "it-IT": "it", "nl-NL": "nl", "pt-BR": "br", "pt-PT": "pt",
  "ja-JP": "jp", "ko-KR": "kr", "zh-CN": "cn", "zh-TW": "tw", "ru-RU": "ru", "pl-PL": "pl", "sv-SE": "se",
};

// traits.custom["ui_lang"] (subset). Language-only codes map to their main UI locale.
const UI_LANG: Record<string, string> = {
  "en-US": "en-us", "en-GB": "en-gb", "en-CA": "en-ca", "en-IN": "en-in", en: "en-us",
  "de-DE": "de-de", de: "de-de", "fr-FR": "fr-fr", "fr-CA": "fr-ca", fr: "fr-fr",
  "ja-JP": "ja-jp", ja: "ja-jp", "pt-BR": "pt-br", pt: "pt-br", "zh-TW": "zh-tw", zh: "zh",
  es: "es", it: "it", nl: "nl", pl: "pl", ru: "ru", sv: "sv", tr: "tr", ko: "ko", uk: "uk",
};

function region(language: string): string {
  if (language === "all") return "all";
  // Plain languages map to their home region ("de" -> "de-DE", "en" -> "en-US").
  const home = `${language}-${language === "en" ? "US" : language.toUpperCase()}`;
  return REGIONS[language] ?? REGIONS[home] ?? "all";
}

function uiLang(language: string): string {
  return UI_LANG[language] ?? UI_LANG[language.split("-")[0]] ?? "en-us";
}

export const brave: Engine = {
  name: "brave",
  maxPage: 10,
  shortcut: "br",
  categories: ["general"],
  paging: true,
  timeRangeSupport: true,
  safesearch: true,
  raiseForHttpError: false,
  request(params) {
    const url = new URL(`${BASE_URL}search`);
    url.searchParams.set("q", params.query);
    url.searchParams.set("source", "web");
    if (params.pageno - 1) url.searchParams.set("offset", String(params.pageno - 1));
    const tf = params.timeRange ? TIME_RANGE[params.timeRange] : undefined;
    if (tf) url.searchParams.set("tf", tf);

    const country = region(params.language);
    return {
      url: url.href,
      headers: { "Accept-Encoding": "gzip, deflate" },
      cookies: {
        safesearch: SAFESEARCH[params.safesearch] ?? "off",
        useLocation: "0",
        summarizer: "0",
        country: country.split("-").pop()!.toLowerCase(),
        ui_lang: uiLang(params.language),
      },
    };
  },

  response(resp) {
    if (isBraveCaptcha(resp.text)) throw new EngineCaptcha("Brave captcha page");
    raiseForHttpError(resp);

    const data = extractJsonData(resp.text);
    let web: { results?: BraveWebResult[] } | undefined;
    try {
      const d = data.data[1].data;
      if (d.noResults) return [];
      web = d.body.response.web;
    } catch {
      throw new EngineError("parse", "Unexpected Brave JSON structure for category 'search'");
    }
    if (!web) return [];
    if (!Array.isArray(web.results)) throw new EngineError("parse", "Brave JSON has no web results list");
    return web.results.map(parseSearchResult);
  },
};

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string | null;
  thumbnail?: { src?: string; logo?: boolean } | null;
}

function parseSearchResult(r: BraveWebResult): EngineResult {
  const out: EngineResult = {
    url: r.url ?? "",
    title: r.title ?? "",
    content: htmlToText(r.description ?? ""),
  };
  const date = parsePublishedDate(r.page_age);
  if (date) out.publishedDate = date;
  const thumb = r.thumbnail && !r.thumbnail.logo ? r.thumbnail.src : undefined;
  if (thumb) out.thumbnail = thumb;
  return out;
}

function parsePublishedDate(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** The captcha page is a SvelteKit app rendered for route "/captcha". */
export function isBraveCaptcha(text: string): boolean {
  return text.includes('page:"/captcha"');
}

/** extract_json_data(): pull the SvelteKit `data: [{...}]` array out of kit.start(...). */
export function extractJsonData(text: string): any {
  const start = text.indexOf("data: [{");
  if (start < 0) throw new EngineError("parse", "Brave: kit.start data not found");
  let newline = text.indexOf("\n", start);
  if (newline < 0) newline = text.length;
  const end = text.lastIndexOf("}}]", newline - 3);
  if (end < start) throw new EngineError("parse", "Brave: end of kit.start data not found");
  const jsObj = "{" + text.slice(start, end) + "}}]}";
  try {
    return JSON.parse(jsObjToJson(jsObj));
  } catch {
    throw new EngineError("parse", "Brave: kit.start data is not parseable");
  }
}

// Port of searx.utils.js_obj_str_to_json_str.
const JSON_PASSTHROUGH_ESCAPES = '"\\bfnrtu';

export function jsObjToJson(js: string): string {
  let inString: string | null = null;
  const parts = js.split(/(["'`])/);
  let backslashBefore = false;
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i];
    if (p === inString && !backslashBefore) {
      inString = null;
      parts[i] = '"';
    } else if (inString) {
      p = p.replace(/:/g, "\x01");
      p = p.replace(/\\(.)/g, (_m, c: string) =>
        JSON_PASSTHROUGH_ESCAPES.includes(c) ? `\\${c}` : c === "x" ? "\\u00" : c,
      );
      if (inString === "'") p = p.replace(/"/g, '\\"');
      parts[i] = p;
      if (backslashBefore && p.startsWith("'")) {
        const prev = parts[i - 1];
        const n = prev.length - prev.replace(/\\+$/, "").length;
        if (n % 2 === 1) parts[i - 1] = prev.slice(0, -1);
      }
    } else if (p === '"' || p === "'" || p === "`") {
      inString = p;
      parts[i] = '"';
    } else {
      p = p.replace(/void\s+[0-9]+|void\s*\([0-9]+\)|undefined/g, "null");
      p = p.replace(/([[,:])\s*(-?)\s*([0-9_]*)\.([0-9_]*)/g, (_m, a, s, x: string, y: string) =>
        `${a}${s}${x.replace(/_/g, "") || "0"}.${y.replace(/_/g, "") || "0"}`,
      );
      p = p.replace(/([[,:])\s*(-?)\s*([0-9_]+)/g, (_m, a, s, x: string) => `${a}${s}${x.replace(/_/g, "")}`);
      p = p.replace(/\s*,\s*([\]}])/g, "$1");
      parts[i] = p;
    }
    backslashBefore = p.length > 0 && p.endsWith("\\");
  }
  return parts
    .join("")
    .replace(/([{\s,])([$_\w][$_\w0-9]*)(:)/g, '$1"$2"$3')
    .replace(/\x01/g, ":")
    .trim();
}
