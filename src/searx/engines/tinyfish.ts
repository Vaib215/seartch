// TinyFish (directly, through treg or through Monid) as engines: a second general-web engine beside
// Yandex, and a news fallback restricted to Indian financial publishers.

import { tinyfishSearch } from "../tinyfish";
import type { Engine, EngineContext, SearchParams } from "../types";
import { INDIA_FINANCE_SITES } from "./india_news";

// Login, app and portal pages that general search returns for long finance queries.
export const JUNK_DOMAINS = [
  "claude.ai", "chatgpt.com", "perplexity.ai", "office365.com", "outlook.com", "live.com", "replit.com",
  "flow.google.com", "cloud.comfy.org", "accounts.google.com", "login.microsoftonline.com",
];

// Bounds a search, including a hedged retry on a second key.
const TINYFISH_TIMEOUT_MS = 7000;

function engine(name: string, shortcut: string, extra: Partial<Engine>, search: Engine["search"]): Engine {
  return {
    name,
    shortcut,
    categories: ["general"],
    timeRangeSupport: true,
    timeout: TINYFISH_TIMEOUT_MS,
    request() {
      return null; // not used: see search()
    },
    response() {
      return [];
    },
    search,
    ...extra,
  };
}

export const tinyfishWeb = engine(
  "tinyfish",
  "tf",
  { about: "TinyFish web search (free per call)" },
  (params: SearchParams, ctx: EngineContext) =>
    tinyfishSearch(params.query, { domainType: "web", timeRange: params.timeRange, excludeDomains: JUNK_DOMAINS }, signalOf(ctx)),
);

export const tinyfishNews = engine(
  "tinyfish news",
  "tfn",
  {
    categories: ["news"],
    fallback: true,
    about: "TinyFish news search over Indian financial publishers; runs when the news engines find too little",
  },
  (params: SearchParams, ctx: EngineContext) =>
    tinyfishSearch(
      params.query,
      { domainType: "news", timeRange: params.timeRange, includeDomains: INDIA_FINANCE_SITES },
      signalOf(ctx),
    ),
);

/** The engine's abort signal, carried on ctx.fetch's init by runEngine. */
function signalOf(ctx: EngineContext): AbortSignal {
  return ctx.signal ?? AbortSignal.timeout(TINYFISH_TIMEOUT_MS);
}
