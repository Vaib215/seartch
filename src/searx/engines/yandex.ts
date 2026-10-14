// Port of searx/engines/yandex.py (search_type "web" only)
// Simplified: image search not ported; also treats a redirect to /showcaptcha as a CAPTCHA.
// Changed: publishedDate comes from the article URL, not Yandex's data-mtime.

import { dateFromUrl } from "../dates";
import { extractText, parseHtml } from "../html";
import { EngineCaptcha, type Engine, type TimeRange } from "../types";

const BASE_URL_WEB = "https://yandex.com/search/site/";
const SUPPORTED_LANGS = ["ru", "en", "be", "fr", "de", "id", "kk", "tt", "tr", "uk"];
const TIME_RANGE_DAYS: Record<TimeRange, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };

export const yandex: Engine = {
  name: "yandex",
  shortcut: "yd",
  categories: ["general"],
  paging: true,
  timeRangeSupport: true,
  disabled: true, // settings.yml
  request(params) {
    const args = new URLSearchParams({ text: params.query });
    if (params.pageno > 1) args.set("p", String(params.pageno - 1));

    const lang = params.language.split("-")[0];
    if (SUPPORTED_LANGS.includes(lang)) args.set("lang", lang);

    if (params.timeRange) {
      const end = new Date();
      const start = new Date(end.getTime() - TIME_RANGE_DAYS[params.timeRange] * 86_400_000);
      args.set("within", "777"); // must be set for time range search, meaning unclear
      args.set("from_day", String(start.getDate()));
      args.set("from_month", String(start.getMonth() + 1));
      args.set("from_year", String(start.getFullYear()));
      args.set("to_day", String(end.getDate()));
      args.set("to_month", String(end.getMonth() + 1));
      args.set("to_year", String(end.getFullYear()));
    }

    args.set("tmpl_version", "releases");
    args.set("web", "1");
    args.set("frame", "1");
    args.set("searchid", "3131712");
    return { url: `${BASE_URL_WEB}?${args}` };
  },
  response(resp) {
    if (resp.headers.get("x-yandex-captcha") === "captcha" || resp.url.includes("/showcaptcha")) {
      throw new EngineCaptcha();
    }
    const dom = parseHtml(resp.text);
    return dom.querySelectorAll('li[class*="serp-item"]').map((item) => {
      const url = item.querySelector("a.b-serp-item__title-link")?.getAttribute("href") ?? "";
      const title = extractText(item.querySelector("h3.b-serp-item__title > a.b-serp-item__title-link > span"));
      const content = extractText(item.querySelector("div.b-serp-item__content div.b-serp-item__text"));
      // yandex.py reads span[data-mtime], but that is Yandex's crawl/modification
      // time (it dated year-old articles to last week); take the date from the URL.
      return { url, title, content, publishedDate: dateFromUrl(url) };
    });
  },
};
