// Engine registry, the equivalent of the `engines:` list in searx/settings.yml.
// Each engine file keeps SearXNG's own `disabled` default; DEFAULTS below is
// this deployment's choice of what runs when a request names no engines.

import type { Engine } from "../types";
import { analysis } from "./analysis";
import { creditRatings } from "./credit_ratings";
import { exchangeFilings } from "./exchange_filings";
import { indexData } from "./index_data";
import { bingNews, indiaFinanceNews, indiaMarketFeeds, regulators } from "./india_news";
import { businessStandard, economicTimes, financialExpress } from "./india_publishers";
import { tinyfishNews, tinyfishWeb } from "./tinyfish";
import { valuepickr } from "./valuepickr";
import { yandex } from "./yandex";
import { yep } from "./yep";

const ALL: Engine[] = [
  // general web
  yandex, yep, tinyfishWeb,
  // news (Indian markets)
  bingNews, indiaFinanceNews, indiaMarketFeeds, economicTimes, financialExpress, businessStandard, tinyfishNews,
  // official sources
  exchangeFilings, regulators, indexData,
  // research: credit-rating rationales and business analysis
  creditRatings, valuepickr, analysis,
];

/**
 * Engines enabled by default here, overriding SearXNG's flag. Every engine
 * listed answers from Cloudflare's network (tested from the DEL colo,
 * 2026-10-17); engines that Cloudflare-hosted requests can't use were removed:
 * DuckDuckGo, Startpage and PyPI (captcha), Google, Yahoo and Qwant (blocked),
 * Brave (unparseable), Bing (off-topic results), Marginalia, Docker Hub and
 * OpenAlex (rate limited), Mojeek (HTTP 403), Mwmbl (timeouts and spam), StackOverflow (keyless
 * quota exhausted) and Google News (times out). Engines outside financial
 * markets (code, packages, papers, Wikipedia) were removed too: seartch is
 * for market news and company research only.
 */
const DEFAULTS = new Set([
  "yandex", "yep", "tinyfish", "tinyfish news",
  "bing news", "india finance news", "india market feeds", "economic times", "financial express", "business standard",
  "exchange filings", "regulators", "index data",
  "credit ratings", "valuepickr", "analysis",
]);

export const ENGINES: Engine[] = ALL.map((e) => ({ ...e, disabled: !DEFAULTS.has(e.name) }));

export const ENGINE_BY_NAME = new Map(ENGINES.map((e) => [e.name, e]));
export const ENGINE_BY_SHORTCUT = new Map(ENGINES.map((e) => [e.shortcut, e]));
