// Port of searx/engines/docker_hub.py (Docker Hub catalog search API).
// Simplified: popularity (pulls, stars) and architectures are folded into
// `content`; maintainer goes to `author`.

import type { Engine } from "../types";

interface DockerSearch {
  results?: {
    name?: string;
    slug?: string;
    source?: string;
    short_description?: string;
    star_count?: number;
    publisher?: { name?: string };
    logo_url?: { large?: string; small?: string };
    updated_at?: string;
    created_at?: string;
    rate_plans?: {
      repositories?: { pull_count?: string | number }[];
      architectures?: { name?: string }[];
    }[];
  }[];
}

const BASE_URL = "https://hub.docker.com";
const PAGE_SIZE = 10;

export const dockerHub: Engine = {
  name: "docker hub",
  shortcut: "dh",
  categories: ["it", "packages"],
  paging: true,
  request(params) {
    const url = new URL(`${BASE_URL}/api/search/v3/catalog/search`);
    url.searchParams.set("query", params.query);
    url.searchParams.set("from", String(PAGE_SIZE * (params.pageno - 1)));
    url.searchParams.set("size", String(PAGE_SIZE));
    return { url: url.href, headers: { accept: "application/json" } };
  },
  response(resp) {
    return (resp.json<DockerSearch>().results ?? []).map((item) => {
      const isOfficial = item.source === "store" || item.source === "official";
      const popularity = [`${item.star_count ?? 0} stars`];
      const archs: string[] = [];
      for (const plan of item.rate_plans ?? []) {
        const pulls = plan.repositories?.[0]?.pull_count;
        if (pulls) popularity.unshift(`${pulls} pulls`);
        for (const a of plan.architectures ?? []) if (a.name) archs.push(a.name);
      }
      const content = [
        item.short_description ?? "",
        popularity.join(", "),
        archs.length ? `[${[...new Set(archs)].join(", ")}]` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      const date = item.updated_at || item.created_at;
      return {
        url: BASE_URL + (isOfficial ? "/_/" : "/r/") + (item.slug ?? ""),
        title: item.name ?? item.slug ?? "",
        content,
        thumbnail: item.logo_url?.large || item.logo_url?.small || undefined,
        author: item.publisher?.name,
        publishedDate: date && !isNaN(Date.parse(date)) ? new Date(date).toISOString() : undefined,
      };
    });
  },
};
