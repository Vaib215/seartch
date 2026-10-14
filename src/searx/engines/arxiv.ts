// Port of searx/engines/arxiv.py (arXiv Atom API).
// Simplified: the Atom feed is parsed with regular expressions (no XML DOM in
// Workers). Paper fields (authors, journal, DOI, categories, comment) are folded
// into `content` ahead of the abstract; the PDF link is not exposed.
// Category mapping: "science" + "scientific publications" -> science.

import { htmlToText } from "../html";
import type { Engine, EngineResult } from "../types";

const BASE_URL = "https://export.arxiv.org/api/query";
const MAX_RESULTS = 10;
const SEARCH_PREFIX = "all";

export const arxiv: Engine = {
  name: "arxiv",
  shortcut: "arx",
  categories: ["science"],
  paging: true,
  request(params) {
    const url = new URL(BASE_URL);
    url.searchParams.set("search_query", `${SEARCH_PREFIX}:${params.query}`);
    url.searchParams.set("start", String((params.pageno - 1) * MAX_RESULTS));
    url.searchParams.set("max_results", String(MAX_RESULTS));
    return { url: url.href, headers: { accept: "application/atom+xml" } };
  },
  response(resp) {
    const results: EngineResult[] = [];
    for (const [, entry] of resp.text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
      const url = tag(entry, "id");
      const title = tag(entry, "title");
      if (!url || !title) continue;
      const abstract = tag(entry, "summary");
      const authors = [...entry.matchAll(/<author\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((m) => htmlToText(m[1]));
      const doi = tag(entry, "arxiv:doi");
      const journal = tag(entry, "arxiv:journal_ref");
      const comment = tag(entry, "arxiv:comment");
      const tags = [...entry.matchAll(/<category\b[^>]*\bterm="([^"]+)"/g)].map((m) => m[1]);
      const published = tag(entry, "published");
      const meta = [authorList(authors), journal, doi ? `DOI ${doi}` : "", tags.join(", "), comment].filter(Boolean).join(" · ");
      results.push({
        url,
        title,
        content: [meta, abstract].filter(Boolean).join(" — "),
        author: authorList(authors) || undefined,
        publishedDate: published && !isNaN(Date.parse(published)) ? new Date(published).toISOString() : undefined,
      });
    }
    return results;
  },
};

/** Text of the first <name>…</name> element in an Atom entry (CDATA-free, entity-decoded). */
function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? htmlToText(m[1]) : "";
}

function authorList(authors: string[]): string {
  return authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ");
}
