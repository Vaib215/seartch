// Port of searx/engines/semantic_scholar.py (Semantic Scholar web app API).
// The X-S2-UI-Version header is scraped from the home page's
// <meta name="s2-ui-version"> and cached for 300 s in ctx.memo, as the Python
// does with EngineCache. Simplified: paper fields (authors, venue, DOI, fields
// of study, citation stats) are folded into `content`; the PDF link is dropped.
// Category mapping: "science" + "scientific publications" -> science.

import { htmlToText } from "../html";
import { CHROME_UA } from "../http";
import { type Engine, type EngineContext, EngineError } from "../types";

interface S2Search {
  results?: {
    id: string;
    title: { text: string };
    paperAbstract?: { text?: string };
    primaryPaperLink?: { url?: string };
    links?: (string | { url?: string })[];
    alternatePaperLinks?: { url?: string; linkType?: string }[];
    pubDate?: string;
    authors?: { name: string }[][];
    venue?: { text?: string };
    journal?: { name?: string };
    doiInfo?: { doi?: string };
    fieldsOfStudy?: string[];
    citationStats?: { numCitations?: number; firstCitationVelocityYear?: number; lastCitationVelocityYear?: number };
  }[];
}

const SEARCH_URL = "https://www.semanticscholar.org/api/1/search";
const BASE_URL = "https://www.semanticscholar.org";
const MEMO_KEY = "semantic_scholar:X-S2-UI-Version";

async function getUiVersion(ctx: EngineContext): Promise<string> {
  const cached = ctx.memo.get(MEMO_KEY);
  if (cached && cached.expires > Date.now()) return cached.value;
  const res = await ctx.fetch(BASE_URL, { headers: { "user-agent": CHROME_UA, accept: "text/html" } });
  const html = await res.text();
  const m = res.ok ? html.match(/<meta[^>]+name=["']s2-ui-version["'][^>]*content=["']([^"']+)["']/i) : null;
  if (!m) throw new EngineError("http", "Can't determine Semantic Scholar UI version");
  ctx.memo.set(MEMO_KEY, { value: m[1], expires: Date.now() + 300_000 });
  return m[1];
}

export const semanticScholar: Engine = {
  name: "semantic scholar",
  shortcut: "se",
  categories: ["science"],
  // SearXNG gives the UI-version pre-fetch its own 3 s timeout on top of the 3 s
  // request_timeout; here one budget covers both requests.
  timeout: 6000,
  paging: true,
  async request(params, ctx) {
    return {
      url: SEARCH_URL,
      method: "POST",
      headers: {
        accept: "application/json",
        "X-S2-UI-Version": await getUiVersion(ctx),
        "X-S2-Client": "webapp-browser",
      },
      json: {
        queryString: params.query,
        page: params.pageno,
        pageSize: 10,
        sort: "relevance",
        getQuerySuggestions: false,
        authors: [],
        coAuthors: [],
        venues: [],
        performTitleMatch: true,
      },
    };
  },
  response(resp) {
    return (resp.json<S2Search>().results ?? []).map((r) => {
      let url = r.primaryPaperLink?.url;
      if (!url && r.links?.length) {
        const l = r.links[0];
        url = typeof l === "string" ? l : l.url;
      }
      if (!url) url = r.alternatePaperLinks?.[0]?.url;
      if (!url) url = `${BASE_URL}/paper/${r.id}`;

      const authors = (r.authors ?? []).map((a) => a[0]?.name).filter(Boolean) as string[];
      const authorStr = authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ");
      const journal = r.venue?.text || r.journal?.name || "";
      const doi = r.doiInfo?.doi;
      const cs = r.citationStats;
      const comments =
        cs && cs.numCitations !== undefined
          ? `${cs.numCitations} citations from the year ${cs.firstCitationVelocityYear} to ${cs.lastCitationVelocityYear}`
          : "";
      const meta = [authorStr, journal, doi ? `DOI ${doi}` : "", (r.fieldsOfStudy ?? []).join(", "), comments]
        .filter(Boolean)
        .join(" · ");
      const abstract = htmlToText(r.paperAbstract?.text);
      return {
        url,
        title: htmlToText(r.title.text),
        content: [meta, abstract].filter(Boolean).join(" — "),
        author: authorStr || undefined,
        publishedDate: r.pubDate && !isNaN(Date.parse(r.pubDate)) ? new Date(r.pubDate).toISOString() : undefined,
      };
    });
  },
};
