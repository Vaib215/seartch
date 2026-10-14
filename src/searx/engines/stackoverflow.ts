// Port of searx/engines/stackexchange.py, instantiated as the "stackoverflow"
// engine from searx/settings.yml (api_site: stackoverflow, shortcut st, [it, q&a]).
// Simplified: only the stackoverflow instance is exported (askubuntu, superuser, ...
// would be further instances of makeStackExchange).

import { decodeEntities } from "../../util";
import type { Category, Engine } from "../types";

interface StackExchangeSearch {
  items?: {
    tags?: string[];
    owner?: { display_name?: string };
    is_answered?: boolean;
    score?: number;
    question_id: number;
    title: string;
  }[];
}

const SEARCH_API = "https://api.stackexchange.com/2.3/search/advanced";
const PAGE_SIZE = 10;

export function makeStackExchange(opts: { name: string; shortcut: string; apiSite: string; categories: Category[] }): Engine {
  return {
    name: opts.name,
    shortcut: opts.shortcut,
    categories: opts.categories,
    paging: true,
    about: "Stack Exchange API v2.3 (no key; 300 requests/day per IP)",
    request(params) {
      const url = new URL(SEARCH_API);
      url.searchParams.set("q", params.query);
      url.searchParams.set("page", String(params.pageno));
      url.searchParams.set("pagesize", String(PAGE_SIZE));
      url.searchParams.set("site", opts.apiSite);
      url.searchParams.set("sort", "activity");
      url.searchParams.set("order", "desc");
      return { url: url.href, headers: { accept: "application/json" } };
    },
    response(resp) {
      return (resp.json<StackExchangeSearch>().items ?? []).map((r) => {
        let content = `[${(r.tags ?? []).join(", ")}] ${r.owner?.display_name ?? ""}`;
        if (r.is_answered) content += " // is answered";
        content += ` // score: ${r.score ?? 0}`;
        return {
          url: `https://${opts.apiSite}.com/q/${r.question_id}`,
          title: decodeEntities(r.title),
          content: decodeEntities(content),
          author: r.owner?.display_name ? decodeEntities(r.owner.display_name) : undefined,
        };
      });
    },
  };
}

export const stackoverflow: Engine = makeStackExchange({
  name: "stackoverflow",
  shortcut: "st",
  apiSite: "stackoverflow",
  categories: ["it", "q&a"],
});
