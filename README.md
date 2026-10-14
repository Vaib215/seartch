# seartch

A self-hosted search API that runs on a single Cloudflare Worker:

- **`/search`**: metasearch, a TypeScript port of [SearXNG](https://github.com/searxng/searxng)'s core. It queries many engines in parallel, merges duplicates and ranks results with SearXNG's scoring.
- **`/fetch`**: fetches pages and returns their main content as clean Markdown, flagging paywalled or teaser articles. It can optionally fall back to the Wayback Machine for blocked or dead pages.
- **`/mcp`**: the same two capabilities as MCP tools (`web_search`, `web_fetch`), so Claude Code, Cursor, Zed and other MCP clients can use it directly.

It needs no containers, no paid search APIs and no API keys for any engine, and it runs on the Workers Paid plan ($5/month).

## Features

- **23 ported SearXNG engines**, plus engines for Indian financial news and stock research:
  - **Exchange filings:** NSE corporate announcements and upcoming board meetings, the same day's BSE announcements, and the latest BSE filings with one-line summaries from screener.in (which also covers BSE-only companies). Vague snippets like "General Updates" are replaced with the subject line read from the filing PDF, and filings with nothing to say are dropped. This answers "did X publish results?" from the source.
  - **Index data:** level, day change, 1-week/1-month/1-year price returns, 52-week range, P/E, P/B and dividend yield for any NSE index (NIFTY 50, Bank Nifty, sector indices, India VIX), shown as a card above the news.
  - **Publishers:** site search for Economic Times, Financial Express and Business Standard; Yandex restricted to nine financial publishers; and 26 live publisher RSS feeds (ET, Mint, Business Standard, CNBC TV18, BusinessLine, NDTV Profit, Business Today).
  - **Regulators:** RBI press releases and notifications, SEBI, and PIB. These run only when the query is about a regulator or regulation, and routine liquidity notices are skipped.
  - Google News (with link decoding) and Bing News, available by name.
- **News mode** (`categories: ["news"]` or `["filings"]`):
  - **Company resolution:** maps the company a query names to every name it goes by (legal name, NSE ticker, BSE code, nicknames like RIL or HUL, the user's own wording). This needs an optional fuzzy ticker-search service; see [Company resolution](#company-resolution).
  - **Relevance:** drops stories that mention none of those names (no TCS stories in a Tata Elxsi search), listing, topic and quote pages, social posts, and gambling or crypto spam. Stories that only mention the company in passing rank lower.
  - **Topics:** in "Infosys deal wins", "deal wins" is the topic. Stories must name the company, and those that also match the topic rank first.
  - **Matching:** subject words must match; reporting jargon only ranks. "Q2", "Q2FY27", "September quarter" and "period ended September 30" count as the same thing.
  - **Real publish dates:** read from article URLs (Mint, Hindustan Times, Business Standard, dated paths) or page metadata, never from search-engine crawl dates.
  - **Recency:** relevance decays with age, `sort: "date"` gives newest first, and `timeRange` accepts `quarter`.
- **SearXNG behaviour:** URL normalisation and duplicate merging, `weight × hits / position` scoring, `!bang` shortcuts (`!gh tokio`, `!science attention`), categories, time ranges and paging.
- **Engine suspension with backoff:** an engine that serves a captcha, a 403 or a 429 is switched off for a while instead of being hit again. State is kept in memory per isolate, as in SearXNG.
- **Per-engine result caching** through the Cache API.
- **Page fetch:**
  - Readability extraction, then Markdown conversion.
  - Charset detection (non-UTF-8 pages decode correctly).
  - PDF and Office files converted with Workers AI `toMarkdown`, with image conversion disabled so it stays free. Scanned pages are counted and flagged; exchange results statements are often scanned past the cover letter.
  - Paywall detection from schema.org `isAccessibleForFree` plus barrier wording and teaser length.
  - Optional Wayback Machine fallback.
- **Bearer-token auth**, compared in constant time.

## Engines

What works depends heavily on **where requests come from**. Many engines block data-center IPs, including Cloudflare's. The defaults in [`src/searx/engines/index.ts`](src/searx/engines/index.ts) are the engines that answered from a Cloudflare Worker in testing. Every engine can still be selected by name or `!bang`.

| Category | On by default | Off by default (blocked from Workers or low quality) |
|---|---|---|
| general | duckduckgo, yandex, wikipedia | brave, bing, yahoo, google, qwant, startpage, mojeek, mwmbl, marginalia, yep |
| it / packages / q&a | github, npm, crates.io, docker hub, hackernews | stackoverflow (keyless quota), pypi (JS challenge) |
| science | arxiv, semantic scholar, openalex | |
| news | india finance news, india market feeds, economic times, financial express, business standard, exchange filings, regulators | google news (HTTP 503 to Workers), bing news (empty feed to Workers) |
| filings | exchange filings, regulators | |
| news + general | index data (cards for NSE indices) | |

Results are best-effort. A site changing its HTML, or blocking an IP range, breaks or suspends that engine until its parser is updated.

## Quick start

```bash
npm install --legacy-peer-deps
cp .dev.vars.example .dev.vars        # set AUTH_TOKEN
npx wrangler dev                      # http://localhost:8787
```

```bash
curl -X POST localhost:8787/search -H "Authorization: Bearer change-me" \
  -d '{"queries":["rust async runtime"],"limit":5}'
```

## Deploy

```bash
npx wrangler deploy
openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
```

### Company resolution

News relevance and exchange filings get much better when the engine knows which company a query is about. That needs a fuzzy ticker-search service that answers:

```
POST /api/stock/fuzzy  {"query": "tata elxsi", "limit": 5}
→ {"data": [{"nseTicker": "TATAELXSI", "bseTicker": "500408", "companyName": "Tata Elxsi Ltd.",
             "isinNumber": "INE670A01012", "marketCap": 21350.3, "matchType": "exact_ticker", "confidence": 1}]}
```

Point seartch at it with either:
- **A service binding** named `TICKER_SEARCH`, for a Worker on the same Cloudflare account. Workers can't `fetch()` other Workers on the same account (error 1042), so this is the way for those.
- **A secret `TICKER_SEARCH_URL`**: `npx wrangler secret put TICKER_SEARCH_URL`.

Keep deployment-specific bindings out of the public config. For example, copy `wrangler.jsonc` to the gitignored `wrangler.private.jsonc`, add `"services": [{ "binding": "TICKER_SEARCH", "service": "<your-worker>" }]`, and deploy with `npx wrangler deploy -c wrangler.private.jsonc`.

Without the service, nothing is resolved. News relevance then falls back to the query's subject words, and exchange filings return nothing.

### Bindings and cost

`wrangler.jsonc` binds only Workers AI, and only for PDF and Office conversion. If you don't want it, remove the `ai` binding; those files then return an "unsupported" error. The fetch code can also use a Browser Run (`BROWSER`) binding as a fallback for JavaScript-heavy pages, but none is configured, because Browser Run is billed separately.

## API

All endpoints except `GET /` need `Authorization: Bearer <AUTH_TOKEN>`.

### `POST /search`

```json
{
  "queries": ["tata elxsi q2 results", "!gh htmlrewriter"],
  "limit": 10,
  "categories": ["news", "general"],
  "engines": ["duckduckgo"],
  "timeRange": "week",
  "sort": "relevance",
  "verifyDates": true,
  "language": "all",
  "pageno": 1,
  "safesearch": 0,
  "includeContent": false,
  "archiveFallback": false
}
```

Up to 5 queries run per call. `engines` overrides `categories`. `timeRange` is `day`, `week`, `month`, `quarter` or `year`; `sort` is `relevance` or `date`. With `includeContent: true`, each result also carries its page as Markdown.

In news mode, each query's response also carries:
- `companies`: what the query resolved to, e.g. `"Tata Elxsi Ltd. (NSE: TATAELXSI, BSE: 500408)"`.
- `dropped`: how many results were filtered as off-topic, non-article, spam or out of range.

`verifyDates: false` skips reading page metadata to date undated results.

### `POST /fetch`

```json
{ "urls": ["https://example.com/article"], "render": "never", "archiveFallback": true }
```

Each result has `markdown`, `via` (`fetch` / `convert` / `wayback`), and when relevant `paywalled`, `partial`, `paywallSignals` and `archivedAt`, or an `error`.

### Others

- `GET /engines`: engine list with each engine's current suspension state.
- `POST /engines/test`: runs engines one by one and reports what each returned. Useful for checking which engines work from your deployment.
- `POST /engines/reset`: clears suspensions.

## MCP

```bash
claude mcp add -s user --transport http seartch https://<your-worker>/mcp \
  --header "Authorization: Bearer <AUTH_TOKEN>"
```

Tools:
- **`web_search`**: queries, limit, categories, engines, timeRange, language, includeContent, maxContentChars.
- **`web_fetch`**: urls, render, archiveFallback, maxChars.

For news, have the client pass `categories: ["news"]` and a `timeRange`.

## Development

```bash
npm test                 # unit + fixture tests in the Workers runtime (vitest + @cloudflare/vitest-plugin)
npm run typecheck
LIVE_ENGINES="duckduckgo,github" LIVE_QUERY="tokio" npx vitest run -c vitest.live.config.ts   # live engine check
```

Each engine lives in `src/searx/engines/<name>.ts` and implements `request(params)` and `response(resp)`. Engines that don't map to a single HTTP request implement `search(params, ctx)` instead. Tests run each engine's parser against a saved response in `test/fixtures/`. The article pages used by the paywall tests are synthetic.

Please respect each site's terms of service and rate limits. Engines that scrape HTML are fragile by nature, and the suspension logic exists so blocked engines back off instead of hammering.

## License

[AGPL-3.0-or-later](LICENSE). This project ports engine and ranking code from [SearXNG](https://github.com/searxng/searxng) (© SearXNG contributors, AGPL-3.0). Under the AGPL, if you run a modified version as a network service, you must offer its source to its users.
