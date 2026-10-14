// Port of searx/engines/marginalia.py
// Simplified: no custom filter validation (setup()); "blogs" category dropped (not in Category).

import type { Engine } from "../types";

/**
 * Marginalia API key, see https://about.marginalia-search.com/article/api/
 * "public" is the shared key the docs mention; it is heavily rate limited (HTTP 429
 * "QPM Limit Exceeded") and SearXNG logs it as invalid. Put a real key here.
 */
export const MARGINALIA_API_KEY = "public";
/** Optional custom filter name (not usable with the public key). */
export const MARGINALIA_FILTER = "";

const BASE_URL = "https://api2.marginalia-search.com";
const RESULTS_PER_PAGE = 20;

interface ApiSearchResults {
  results?: { url: string; title: string; description?: string }[];
}

export const marginalia: Engine = {
  name: "marginalia",
  shortcut: "mar",
  categories: ["general"],
  paging: true,
  safesearch: true,
  // settings.yml: disabled + inactive (needs an API key).
  disabled: true,
  about: "Needs a Marginalia API key; the shared 'public' key is almost always rate limited (429).",
  request(params) {
    const q = new URLSearchParams({
      page: String(params.pageno),
      count: String(RESULTS_PER_PAGE),
      nsfw: String(Math.min(params.safesearch, 1)),
      query: params.query,
    });
    if (MARGINALIA_FILTER) q.set("filter", MARGINALIA_FILTER);
    return { url: `${BASE_URL}/search?${q}`, headers: { "API-Key": MARGINALIA_API_KEY } };
  },
  response(resp) {
    return (resp.json<ApiSearchResults>().results ?? []).map((item) => ({
      url: item.url,
      title: item.title,
      content: item.description ?? "",
    }));
  },
};
