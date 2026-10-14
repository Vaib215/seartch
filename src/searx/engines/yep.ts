// Port of searx/engines/yep.py
// Simplified: "hl" is the base language code ("en-US" -> en) instead of engine_traits.

import { htmlToText } from "../html";
import { EngineParseError, type Engine } from "../types";

const BASE_URL = "https://api.yep.com";
const WEB_BASE_URL = "https://yep.com";
const SAFESEARCH_MAP = { 0: "off", 1: "moderate", 2: "strict" } as const;
const RESULTS_PER_PAGE = 20;

interface YepResult {
  url: string;
  title: string;
  snippet?: string;
}

export const yep: Engine = {
  name: "yep",
  shortcut: "yep",
  categories: ["general"],
  safesearch: true,
  disabled: true, // settings.yml
  about: "api.yep.com answers this machine with a Cloudflare block page (HTTP 403).",
  request(params) {
    const q = new URLSearchParams({
      query: params.query,
      safeSearch: SAFESEARCH_MAP[params.safesearch],
      limit: String(RESULTS_PER_PAGE),
    });
    if (params.language !== "all") {
      const lang = params.language.split("-")[0].toLowerCase();
      if (lang) q.set("hl", lang);
    }
    return {
      url: `${BASE_URL}/search?${q}`,
      headers: { referer: `${WEB_BASE_URL}/`, origin: WEB_BASE_URL },
    };
  },
  response(resp) {
    // Response shape: ["Ok", { results: [...] }]
    const data = resp.json<[unknown, { results?: YepResult[] }]>();
    if (!Array.isArray(data) || !data[1]) throw new EngineParseError("unexpected yep response shape");
    return (data[1].results ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      content: htmlToText(r.snippet),
    }));
  },
};
