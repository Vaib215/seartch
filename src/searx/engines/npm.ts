// Port of searx/engines/npm.py (npms.io search API).
// Simplified: packages.html fields (version, maintainer, tags, homepage, source
// code URL) are folded into `content`/`author`. Disabled as in settings.yml.

import type { Engine } from "../types";

interface NpmsSearch {
  results?: {
    flags?: Record<string, unknown>;
    package: {
      name: string;
      version?: string;
      description?: string;
      keywords?: string[];
      date?: string;
      author?: { name?: string };
      links: { npm: string; homepage?: string; repository?: string };
    };
  }[];
}

const PAGE_SIZE = 25;

export const npm: Engine = {
  name: "npm",
  shortcut: "npm",
  categories: ["it", "packages"],
  timeout: 5000,
  paging: true,
  disabled: true,
  about: "npms.io search API (disabled by default in SearXNG; npms.io index is stale)",
  request(params) {
    const url = new URL("https://api.npms.io/v2/search");
    url.searchParams.set("from", String((params.pageno - 1) * PAGE_SIZE));
    url.searchParams.set("q", params.query);
    url.searchParams.set("size", String(PAGE_SIZE));
    return { url: url.href, headers: { accept: "application/json" } };
  },
  response(resp) {
    return (resp.json<NpmsSearch>().results ?? []).map(({ package: p, flags }) => {
      const tags = [...Object.keys(flags ?? {}), ...(p.keywords ?? [])];
      const content = [
        p.version ? `v${p.version}` : "",
        p.description ?? "",
        tags.length ? `[${tags.slice(0, 8).join(", ")}]` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      return {
        url: p.links.npm,
        title: p.name,
        content,
        author: p.author?.name,
        publishedDate: isoDate(p.date),
      };
    });
  },
};

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
