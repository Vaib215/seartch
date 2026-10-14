// Port of searx/engines/github.py

import type { Engine } from "../types";

interface GithubSearch {
  items?: {
    html_url: string;
    full_name: string;
    description?: string | null;
    language?: string | null;
    stargazers_count?: number;
    updated_at?: string;
    created_at?: string;
    owner?: { avatar_url?: string; login?: string };
  }[];
}

export const github: Engine = {
  name: "github",
  shortcut: "gh",
  categories: ["it", "repos"],
  request(params) {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("q", params.query);
    return { url: url.href, headers: { accept: "application/vnd.github.preview.text-match+json" } };
  },
  response(resp) {
    return (resp.json<GithubSearch>().items ?? []).map((item) => ({
      url: item.html_url,
      title: item.full_name,
      content: [item.language, item.description].filter(Boolean).join(" / "),
      thumbnail: item.owner?.avatar_url,
      author: item.owner?.login,
      publishedDate: item.updated_at ?? item.created_at,
    }));
  },
};
