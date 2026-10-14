// Port of searx/engines/openalex.py (OpenAlex Works API).
// Simplified: paper fields (authors, journal, publisher, volume/issue/pages,
// DOI, type, citations, first concepts) are folded into `content` ahead of the
// abstract (reconstructed from the inverted index). OpenAlex dropped
// `host_venue`; journal/publisher fall back to primary_location.source as the
// Python's host_venue lookup now always comes back empty. No `mailto` set.
// Category mapping: "science" + "scientific publications" -> science.

import type { Engine } from "../types";

interface OpenAlexWork {
  id?: string;
  title?: string | null;
  doi?: string | null;
  type?: string | null;
  publication_date?: string | null;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: {
    landing_page_url?: string | null;
    pdf_url?: string | null;
    source?: { display_name?: string | null; host_organization_name?: string | null } | null;
  } | null;
  open_access?: { oa_url?: string | null } | null;
  host_venue?: { display_name?: string; publisher?: string } | null;
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null } | null;
  authorships?: ({ author?: { display_name?: string | null } } | null)[];
  concepts?: ({ display_name?: string | null } | null)[];
}

const SEARCH_URL = "https://api.openalex.org/works";
const MAILTO = "";

export const openalex: Engine = {
  name: "openalex",
  shortcut: "oa",
  categories: ["science"],
  timeout: 5000,
  paging: true,
  disabled: true,
  about: "OpenAlex Works API (disabled by default in SearXNG)",
  request(params) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("search", params.query);
    url.searchParams.set("page", String(params.pageno));
    url.searchParams.set("per-page", "10");
    url.searchParams.set("sort", "relevance_score:desc");
    if (params.language && params.language !== "all") {
      const iso2 = params.language.split("-")[0].split("_")[0];
      if (iso2.length === 2) url.searchParams.set("filter", `language:${iso2}`);
    }
    if (MAILTO) url.searchParams.set("mailto", MAILTO);
    return { url: url.href, headers: { accept: "application/json" } };
  },
  response(resp) {
    const data = resp.json<{ results?: OpenAlexWork[] }>();
    return (data.results ?? []).flatMap((item) => {
      const landing = item.primary_location?.landing_page_url || "";
      const url = landing || item.id || "";
      const title = item.title ?? "";
      if (!url || !title) return [];
      const authors = (item.authorships ?? []).map((a) => a?.author?.display_name).filter((n): n is string => !!n);
      const authorStr = authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ");
      const journal = item.host_venue?.display_name || item.primary_location?.source?.display_name || "";
      const publisher = item.host_venue?.publisher || item.primary_location?.source?.host_organization_name || "";
      const b = item.biblio ?? {};
      const pages = b.first_page && b.last_page ? `${b.first_page}-${b.last_page}` : b.first_page || b.last_page || "";
      const biblio = [b.volume ? `vol. ${b.volume}` : "", b.issue ? `no. ${b.issue}` : "", pages ? `pp. ${pages}` : ""]
        .filter(Boolean)
        .join(", ");
      const doi = (item.doi ?? "").replace(/^https:\/\/doi\.org\//, "");
      const tags = (item.concepts ?? []).map((c) => c?.display_name).filter((n): n is string => !!n).slice(0, 3);
      const comments = typeof item.cited_by_count === "number" ? `${item.cited_by_count} citations` : "";
      const meta = [authorStr, journal, publisher, biblio, doi ? `DOI ${doi}` : "", item.type ?? "", comments, tags.join(", ")]
        .filter(Boolean)
        .join(" · ");
      const abstract = reconstructAbstract(item.abstract_inverted_index);
      return [
        {
          url,
          title,
          content: [meta, abstract].filter(Boolean).join(" — "),
          author: authorStr || undefined,
          publishedDate: parseDate(item.publication_date),
        },
      ];
    });
  },
};

function reconstructAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const tokens: string[] = [];
  for (const [token, positions] of Object.entries(index)) for (const p of positions) tokens[p] = token;
  return tokens.filter((t) => t).join(" ");
}

function parseDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const m = value.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!m) return undefined;
  return new Date(Date.UTC(+m[1], +(m[2] ?? 1) - 1, +(m[3] ?? 1))).toISOString();
}
