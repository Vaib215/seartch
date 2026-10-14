# seartch

A self-hosted search API that runs on a single Cloudflare Worker:

- **`/search`**: metasearch, a TypeScript port of [SearXNG](https://github.com/searxng/searxng)'s core. It queries many engines in parallel, merges duplicates and ranks results with SearXNG's scoring.
- **`/fetch`**: fetches pages and returns their main content as clean Markdown, flagging paywalled or teaser articles. It can optionally fall back to the Wayback Machine for blocked or dead pages.
- **`/mcp`**: the same two capabilities as MCP tools (`web_search`, `web_fetch`), so Claude Code, Cursor, Zed and other MCP clients can use it directly.

It needs no containers, no paid search APIs and no API keys for any engine, and it runs on the Workers Paid plan ($5/month).

## Features

- **23 ported SearXNG engines**, plus Indian financial-news engines: Google News with link decoding, Economic Times, Financial Express, Business Standard, Yandex restricted to financial publishers, and live publisher RSS feeds.
- **SearXNG behaviour:** URL normalisation and duplicate merging, `weight × hits / position` scoring, `!bang` shortcuts (`!gh tokio`, `!science attention`), categories, time ranges and paging.
- **Engine suspension with backoff:** an engine that serves a captcha, a 403 or a 429 is switched off for a while instead of being hit again. State is kept in memory per isolate, as in SearXNG.
- **Per-engine result caching** through the Cache API.
- **Page fetch:**
  - Readability extraction, then Markdown conversion.
  - Charset detection (non-UTF-8 pages decode correctly).
  - PDF and Office files converted with Workers AI `toMarkdown`, with image conversion disabled so it stays free.
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
| news | google news, india finance news, india market feeds, economic times, financial express, business standard | bing news |

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
  "language": "all",
  "pageno": 1,
  "safesearch": 0,
  "includeContent": false,
  "archiveFallback": false
}
```

Up to 5 queries run per call. `engines` overrides `categories`. With `includeContent: true`, each result also carries its page as Markdown.

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
