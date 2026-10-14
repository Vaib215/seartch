// Engine registry, the equivalent of the `engines:` list in searx/settings.yml.
// Each engine file keeps SearXNG's own `disabled` default; DEFAULTS below is
// this deployment's choice of what runs when a request names no engines.

import type { Engine } from "../types";
import { arxiv } from "./arxiv";
import { bing } from "./bing";
import { brave } from "./brave";
import { crates } from "./crates";
import { dockerHub } from "./docker_hub";
import { duckduckgo } from "./duckduckgo";
import { github } from "./github";
import { google } from "./google";
import { googleNews } from "./google_news";
import { hackernews } from "./hackernews";
import { bingNews, indiaFinanceNews, indiaMarketFeeds } from "./india_news";
import { businessStandard, economicTimes, financialExpress } from "./india_publishers";
import { marginalia } from "./marginalia";
import { mojeek } from "./mojeek";
import { mwmbl } from "./mwmbl";
import { npm } from "./npm";
import { openalex } from "./openalex";
import { pypi } from "./pypi";
import { qwant } from "./qwant";
import { semanticScholar } from "./semantic_scholar";
import { stackoverflow } from "./stackoverflow";
import { startpage } from "./startpage";
import { wikipedia } from "./wikipedia";
import { yahoo } from "./yahoo";
import { yandex } from "./yandex";
import { yep } from "./yep";

const ALL: Engine[] = [
  // general web
  duckduckgo, brave, bing, yahoo, yandex, google, qwant, startpage, mojeek, mwmbl, marginalia, yep, wikipedia,
  // it / packages / q&a
  github, stackoverflow, npm, crates, dockerHub, hackernews, pypi,
  // science
  arxiv, semanticScholar, openalex,
  // news (Indian markets)
  googleNews, bingNews, indiaFinanceNews, indiaMarketFeeds, economicTimes, financialExpress, businessStandard,
];

/**
 * Engines enabled by default here, overriding SearXNG's flag. Chosen from what
 * answers from Cloudflare's network (tested from the DEL colo, 2026-10-09):
 * DuckDuckGo and Yandex work there (Mwmbl too, but returns spam). Brave, Yahoo, Google, Qwant,
 * Startpage, Mojeek and Yep block Worker requests; Bing answers but with
 * off-topic results; StackOverflow's keyless API quota is exhausted on shared
 * Cloudflare IPs; Bing News returns an empty feed to Worker requests (it works
 * from residential IPs, so it stays available by name). Everything else can
 * still be selected by name or `!bang`.
 */
const DEFAULTS = new Set([
  "duckduckgo", "yandex", "wikipedia",
  "github", "npm", "crates.io", "docker hub", "hackernews",
  "arxiv", "semantic scholar", "openalex",
  "google news", "india finance news", "india market feeds", "economic times", "financial express", "business standard",
]);

export const ENGINES: Engine[] = ALL.map((e) => ({ ...e, disabled: !DEFAULTS.has(e.name) }));

export const ENGINE_BY_NAME = new Map(ENGINES.map((e) => [e.name, e]));
export const ENGINE_BY_SHORTCUT = new Map(ENGINES.map((e) => [e.shortcut, e]));
