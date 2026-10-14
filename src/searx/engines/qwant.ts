// Port of searx/engines/qwant.py (qwant_categ: web only)
// Simplified: locale from a small hard-coded table instead of engine_traits;
// datadome cookie cached in a module variable instead of EngineCache;
// max_page (5) is enforced in response() since requests can't be skipped.

import { raiseForHttpError } from "../http";
import {
  EngineAccessDenied,
  EngineCaptcha,
  EngineError,
  EngineTooManyRequests,
  type Engine,
  type EngineResult,
} from "../types";

const BASE_URL = "https://www.qwant.com";
const API_URL = "https://api.qwant.com/v3/search/";
const QWANT_CATEG = "web";
const RESULTS_PER_PAGE = 10;
const MAX_PAGE = 5;

// "tgp" (test group): value doesn't matter as long as it is stable-ish.
const TEST_GROUP_VALUE = 1 + Math.floor(Math.random() * 3);

const DEFAULT_LOCALE: Record<string, string> = {
  en: "en_US",
  de: "de_DE",
  fr: "fr_FR",
  es: "es_ES",
  it: "it_IT",
  nl: "nl_NL",
  pt: "pt_PT",
  pl: "pl_PL",
  ca: "ca_ES",
  eu: "eu_ES",
};

export function qwantLocale(language: string): string {
  if (!language || language === "all") return "en_US";
  const [lang, cc] = language.split("-");
  if (cc) return `${lang.toLowerCase()}_${cc.toUpperCase()}`;
  return DEFAULT_LOCALE[lang.toLowerCase()] ?? "en_US";
}

/** Stand-in for EngineCache: the datadome cookie changes on each request. */
let datadome: string | undefined;

interface QwantItem {
  title?: string;
  url?: string;
  desc?: string;
}
interface QwantResponse {
  status?: string;
  url?: string;
  data?: {
    error_code?: number;
    message?: string[];
    result?: { items?: { mainline?: { type?: string; items?: QwantItem[] }[] } };
  };
}

export const qwant: Engine = {
  name: "qwant",
  maxPage: MAX_PAGE,
  shortcut: "qw",
  categories: ["general"],
  disabled: true,
  paging: true,
  safesearch: true,
  raiseForHttpError: false,
  request(params) {
    const url = new URL(`${API_URL}${QWANT_CATEG}`);
    // Order matters to Qwant's bot detection; keep qwant.py's order.
    url.search = new URLSearchParams({
      q: params.query,
      count: String(RESULTS_PER_PAGE),
      locale: qwantLocale(params.language),
      offset: String((params.pageno - 1) * RESULTS_PER_PAGE),
      tgp: String(TEST_GROUP_VALUE),
      device: "desktop",
      safesearch: String(params.safesearch),
      displayed: "true",
      llm: "true",
    }).toString();
    return {
      url: url.href,
      cookies: datadome ? { datadome } : undefined,
      headers: { accept: "application/json", referer: `${BASE_URL}/`, origin: BASE_URL },
    };
  },
  response(resp, params) {
    const all = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [resp.headers.get("set-cookie") ?? ""];
    for (const c of all) {
      const m = c.match(/(?:^|[;,]\s*)datadome=([^;]*)/);
      if (m) datadome = m[1];
    }
    if (params.pageno > MAX_PAGE) return [];

    let search: QwantResponse = {};
    try {
      search = JSON.parse(resp.text);
    } catch {
      // fall through: treated like a non-success API answer
    }
    const data = search.data ?? {};
    if (search.status !== "success") {
      const errorCode = data.error_code;
      if (errorCode === 24) throw new EngineTooManyRequests();
      if (search.url != null) throw new EngineCaptcha("datadome CAPTCHA", 0);
      if (resp.status === 403) throw new EngineAccessDenied();
      const msg = (data.message ?? ["unknown"]).join(",");
      throw new EngineError("http", `${msg} (${errorCode})`);
    }
    raiseForHttpError(resp);

    const mainline = data.result?.items?.mainline ?? [];
    const results: EngineResult[] = [];
    for (const row of mainline) {
      const type = row.type ?? "web";
      if (type !== QWANT_CATEG) continue;
      for (const item of row.items ?? []) {
        results.push({ title: item.title ?? "", url: item.url ?? "", content: item.desc ?? "" });
      }
    }
    return results;
  },
};
