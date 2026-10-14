// Port of searx/engines/mwmbl.py
// Nothing simplified (mwmbl has no paging, language, safesearch or time range).

import type { Engine } from "../types";

const API_URL = "https://api.mwmbl.org/api/v1";

interface MwmblResult {
  url: string;
  title: { value: string }[];
  extract?: { value: string }[];
}

export const mwmbl: Engine = {
  name: "mwmbl",
  shortcut: "mwm",
  categories: ["general"],
  disabled: true, // settings.yml
  request(params) {
    return { url: `${API_URL}/search/?${new URLSearchParams({ s: params.query })}` };
  },
  response(resp) {
    return resp.json<MwmblResult[]>().map((r) => ({
      url: r.url,
      title: r.title.map((t) => t.value).join(""),
      content: (r.extract ?? []).map((e) => e.value).join(""),
    }));
  },
};
