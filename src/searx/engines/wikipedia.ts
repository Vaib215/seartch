// Port of searx/engines/wikipedia.py
// Simplified: wiki subdomain is the base language code ("en-US" -> en.wikipedia.org,
// "all" -> en) instead of engine_traits; the infobox summary is emitted as one normal result;
// "/" in titles is percent-encoded (Python leaves it).

import { raiseForHttpError } from "../http";
import { htmlToText } from "../html";
import type { Engine } from "../types";

interface WikiSummary {
  type?: string;
  title?: string;
  titles?: { display?: string };
  description?: string;
  extract?: string;
  thumbnail?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
}

/** Python's str.title(): uppercase every letter that follows a non-letter. */
function pyTitle(s: string): string {
  return s.replace(/(^|[^\p{L}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

/** Python's str.islower(): has a cased char and no uppercase chars. */
function pyIsLower(s: string): boolean {
  return s !== s.toUpperCase() && s === s.toLowerCase();
}

/** urllib.parse.quote(), except "/" is escaped too so titles like "AC/DC" stay one path segment. */
function quote(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function wikiLang(language: string): string {
  if (language === "all") return "en";
  const lang = language.split("-")[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(lang) ? lang : "en";
}

export const wikipedia: Engine = {
  name: "wikipedia",
  shortcut: "wp",
  categories: ["general"],
  raiseForHttpError: false,
  request(params) {
    let query = params.query;
    if (pyIsLower(query)) query = pyTitle(query);
    const netloc = `${wikiLang(params.language)}.wikipedia.org`;
    const headers: Record<string, string> = {};
    if (params.language !== "all") headers["accept-language"] = `${params.language},${wikiLang(params.language)};q=0.9`;
    return { url: `https://${netloc}/api/rest_v1/page/summary/${quote(query)}`, headers };
  },
  response(resp) {
    if (resp.status === 404) return [];
    if (resp.status === 400) {
      try {
        const err = JSON.parse(resp.text);
        if (err?.type === "https://mediawiki.org/wiki/HyperSwitch/errors/bad_request" && err?.detail === "title-invalid-characters") {
          return [];
        }
      } catch {
        // fall through to the generic HTTP error
      }
    }
    raiseForHttpError(resp);

    const api = resp.json<WikiSummary>();
    const url = api.content_urls?.desktop?.page;
    if (!url) return [];
    const title = htmlToText(api.titles?.display || api.title);
    // Python: standard pages become an infobox (extract + image); others a list hit (description).
    const standard = api.type === "standard";
    return [
      {
        url,
        title,
        content: (standard ? api.extract || api.description : api.description) ?? "",
        thumbnail: standard ? api.thumbnail?.source : undefined,
      },
    ];
  },
};
