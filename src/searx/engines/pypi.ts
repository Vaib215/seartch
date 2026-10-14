// Port of searx/engines/pypi.py (scrapes https://pypi.org/search/).
// Simplified: the XPath is replaced by CSS selectors on a.package-snippet;
// version is folded into `content`. PyPI now fronts /search/ with a Fastly
// JavaScript challenge page, which is reported as a CAPTCHA.

import { extractText, parseHtml } from "../html";
import { type Engine, EngineCaptcha } from "../types";

const BASE_URL = "https://pypi.org";

export const pypi: Engine = {
  name: "pypi",
  shortcut: "pypi",
  categories: ["it", "packages"],
  paging: true,
  disabled: true,
  about: "Scrapes pypi.org/search; disabled because PyPI serves a Fastly JS challenge to non-browser clients",
  request(params) {
    const url = new URL(`${BASE_URL}/search/`);
    url.searchParams.set("q", params.query);
    url.searchParams.set("page", String(params.pageno));
    return { url: url.href };
  },
  response(resp) {
    if (resp.text.includes("/_fs-ch-") && !resp.text.includes("package-snippet")) {
      throw new EngineCaptcha("PyPI Fastly challenge");
    }
    const dom = parseHtml(resp.text);
    return dom.querySelectorAll("a.package-snippet").map((entry) => {
      const title = extractText(entry.querySelector(".package-snippet__name"));
      const version = extractText(entry.querySelector(".package-snippet__version"));
      const created = entry.querySelector(".package-snippet__created time")?.getAttribute("datetime");
      const description = extractText(entry.querySelector("p"));
      const date = created ? new Date(created) : undefined;
      return {
        url: BASE_URL + (entry.getAttribute("href") ?? ""),
        title,
        content: [version ? `v${version}` : "", description].filter(Boolean).join(" / "),
        publishedDate: date && !isNaN(date.getTime()) ? date.toISOString() : undefined,
      };
    });
  },
};
