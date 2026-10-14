// Port of searx/engines/crates.py (crates.io API).
// Simplified: the "cargo" category has no equivalent and is dropped; version,
// keywords and links are folded into `content`. Disabled as in settings.yml.

import type { Engine } from "../types";

interface CratesSearch {
  crates?: {
    name: string;
    description?: string | null;
    keywords?: string[] | null;
    newest_version?: string | null;
    max_version?: string | null;
    max_stable_version?: string | null;
    updated_at?: string;
    homepage?: string | null;
    documentation?: string | null;
    repository?: string | null;
  }[];
}

const PAGE_SIZE = 10;

export const crates: Engine = {
  name: "crates.io",
  shortcut: "crates",
  categories: ["it", "packages"],
  timeout: 6000,
  paging: true,
  disabled: true,
  about: "crates.io API (disabled by default in SearXNG)",
  request(params) {
    const url = new URL("https://crates.io/api/v1/crates");
    url.searchParams.set("page", String(params.pageno));
    url.searchParams.set("q", params.query);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    // crates.io's crawler policy requires an identifying User-Agent.
    return { url: url.href, headers: { accept: "application/json", "user-agent": "web-search-worker (SearXNG port)" } };
  },
  response(resp) {
    return (resp.json<CratesSearch>().crates ?? []).map((c) => {
      const version = c.newest_version || c.max_version || c.max_stable_version;
      const content = [
        version ? `v${version}` : "",
        c.description?.trim() ?? "",
        c.keywords?.length ? `[${c.keywords.join(", ")}]` : "",
        c.repository ? `source: ${c.repository}` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      return {
        url: `https://crates.io/crates/${c.name}`,
        title: c.name,
        content,
        publishedDate: isoDate(c.updated_at),
      };
    });
  },
};

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
