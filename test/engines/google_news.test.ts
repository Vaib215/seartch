import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  articleId,
  batchRequestBody,
  checkBlocked,
  clearResolveCache,
  decodeOfflineId,
  edition,
  googleNews,
  parseArticlePage,
  parseBatchResponse,
  parseFeed,
  resolveIds,
  splitTitle,
  withinRange,
} from "../../src/searx/engines/google_news";
import articleFx from "../fixtures/google_news_article.html?raw";
import batchFx from "../fixtures/google_news_batchexecute.txt?raw";
import rssFx from "../fixtures/google_news.xml?raw";
import { PARAMS, fakeResponse } from "../helpers";

// Fixture captured on 2026-10-08 ~19:40 UTC for "Infosys when:7d".
const FIXTURE_NOW = Date.parse("2026-10-08T19:40:00Z");

function base64Url(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An old-style id: protobuf 08 13 22 <len> <url> (d2 01 <len> <amp url>). */
function oldStyleId(url: string): string {
  const u = [...new TextEncoder().encode(url)];
  return base64Url([0x08, 0x13, 0x22, u.length, ...u, 0xd2, 0x01, 0x03, 0x61, 0x6d, 0x70]);
}

/** A ctx whose fetch serves article pages and batchexecute from fixtures, counting calls. */
function fakeCtx(opts: { pageStatus?: number; pageUrl?: string } = {}) {
  const calls: string[] = [];
  const ctx = {
    memo: new Map(),
    async fetch(input: string | URL, init?: RequestInit) {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
      if (url.includes("/batchexecute")) return new Response(batchFx, { status: 200 });
      const res = new Response(articleFx, { status: opts.pageStatus ?? 200 });
      Object.defineProperty(res, "url", { value: opts.pageUrl ?? url });
      return res;
    },
  };
  return { ctx: ctx as any, calls };
}

beforeEach(() => clearResolveCache());
afterEach(() => vi.useRealTimers());

describe("google news request", () => {
  it("defaults to the Indian edition and appends when: for time ranges", async () => {
    const req = (await googleNews.request({ ...PARAMS, query: "Infosys Q2", timeRange: "week" }, {} as any))!;
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://news.google.com/rss/search");
    expect(u.searchParams.get("q")).toBe("Infosys Q2 when:7d");
    expect(u.searchParams.get("hl")).toBe("en-IN");
    expect(u.searchParams.get("gl")).toBe("IN");
    expect(u.searchParams.get("ceid")).toBe("IN:en");
    const plain = (await googleNews.request({ ...PARAMS, query: "TCS" }, {} as any))!;
    expect(new URL(plain.url).searchParams.get("q")).toBe("TCS");
    for (const [tr, w] of [["day", "1d"], ["month", "30d"], ["year", "1y"]] as const) {
      const r = (await googleNews.request({ ...PARAMS, timeRange: tr }, {} as any))!;
      expect(new URL(r.url).searchParams.get("q")).toBe(`test when:${w}`);
    }
  });

  it("maps explicit languages to editions", () => {
    expect(edition("all")).toEqual({ hl: "en-IN", gl: "IN", ceid: "IN:en" });
    expect(edition("en")).toEqual({ hl: "en-IN", gl: "IN", ceid: "IN:en" });
    expect(edition("en-US")).toEqual({ hl: "en-US", gl: "US", ceid: "US:en" });
    expect(edition("en-GB")).toEqual({ hl: "en-GB", gl: "GB", ceid: "GB:en" });
    expect(edition("hi")).toEqual({ hl: "hi", gl: "IN", ceid: "IN:hi" });
    expect(edition("de-DE")).toEqual({ hl: "de", gl: "DE", ceid: "DE:de" });
    expect(edition("fr")).toEqual({ hl: "fr", gl: "FR", ceid: "FR:fr" });
    expect(edition("pt-BR")).toEqual({ hl: "pt-BR", gl: "BR", ceid: "BR:pt-419" });
  });
});

describe("google news feed parsing", () => {
  it("splits the publisher off titles and keeps dates", () => {
    const items = parseFeed(rssFx);
    expect(items).toHaveLength(20);
    expect(items[1]).toEqual({
      id: expect.stringMatching(/^CBMi/),
      title: "Cognizant, Infosys, Tata, Wipro and HCL among IT firms suspended from U.S. green card programme",
      publisher: "The Hindu",
      date: "2026-10-08T15:33:46.000Z",
    });
    // A publisher name containing " - " still splits at the <source> boundary.
    expect(items[2].title).toBe("INFY Share Price Today - Infosys on NSE/BSE");
    expect(items[2].publisher).toBe("scanx.trade");
    for (const it of items) {
      expect(it.title).not.toMatch(/ - (The Hindu|The Times of India|Yahoo Finance Singapore)$/);
      expect(it.publisher).toBeTruthy();
      expect(it.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("splits titles without a <source>", () => {
    expect(splitTitle("Infosys Q2 beat - Mint")).toEqual({ title: "Infosys Q2 beat", publisher: "Mint" });
    expect(splitTitle("No publisher here")).toEqual({ title: "No publisher here", publisher: undefined });
  });

  it("extracts article ids from links", () => {
    expect(articleId("https://news.google.com/rss/articles/CBMiAbc_-1?oc=5")).toBe("CBMiAbc_-1");
    expect(articleId("https://news.google.com/articles/CBMiXyz")).toBe("CBMiXyz");
    expect(articleId("https://example.com/rss/articles/CBMi")).toBeUndefined();
  });

  it("post-filters by time range", () => {
    const items = parseFeed(rssFx);
    const day = withinRange(items, "day", FIXTURE_NOW);
    expect(day.length).toBeGreaterThan(5);
    expect(day.length).toBeLessThan(items.length);
    for (const it of day) expect(Date.parse(it.date!)).toBeGreaterThanOrEqual(FIXTURE_NOW - 86_400_000);
    expect(withinRange(items, undefined, FIXTURE_NOW)).toHaveLength(items.length);
  });
});

describe("google news id decoding", () => {
  it("decodes old-style ids offline and rejects current opaque ids", () => {
    const url = "https://www.livemint.com/market/stock-market-news/infosys-q2-results-123.html";
    expect(decodeOfflineId(oldStyleId(url))).toBe(url);
    for (const it of parseFeed(rssFx)) expect(decodeOfflineId(it.id)).toBeUndefined();
    expect(decodeOfflineId("not*base64")).toBeUndefined();
  });

  it("reads the timestamp and signature from an article page", () => {
    const sig = parseArticlePage(articleFx, "ID");
    expect(sig).toEqual({ id: "ID", ts: 1791488422, sig: "AbIaSL8SS1MMrCG31t6_N5g8x4NQ" });
    expect(parseArticlePage("<html></html>", "ID")).toBeUndefined();
  });

  it("builds one batchexecute body with an indexed Fbv4je call per article", () => {
    const body = JSON.parse(batchRequestBody([
      { id: "A", ts: 1, sig: "s1" },
      { id: "B", ts: 2, sig: "s2" },
    ]));
    expect(body[0]).toHaveLength(2);
    const [rpc, args, , index] = body[0][1];
    expect(rpc).toBe("Fbv4je");
    expect(index).toBe("2");
    const parsed = JSON.parse(args);
    expect(parsed[0]).toBe("garturlreq");
    expect(parsed.slice(2)).toEqual(["B", 2, "s2"]);
    expect(parsed[1][0][7]).toBe("IN:en");
  });

  it("parses batched responses that arrive out of order", () => {
    const urls = parseBatchResponse(batchFx);
    expect(urls.size).toBe(3);
    expect(urls.get(1)).toBe("https://scanx.trade/company/infosys-ltd");
    expect(urls.get(2)).toMatch(/^https:\/\/timesofindia\.indiatimes\.com\/.*articleshow\/134774150\.cms$/);
    expect(urls.get(3)).toMatch(/^https:\/\/www\.indiatoday\.in\/world\/story\//);
  });

  it("skips failed calls and handles the chunked framing", () => {
    const failed = `)]}'\n\n[["wrb.fr","Fbv4je",null,null,null,[3],"1"],["di",17]]`;
    expect(parseBatchResponse(failed).size).toBe(0);
    const entry = JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", "https://x.com/a", 1]), null, null, null, "generic"]]);
    const chunked = `)]}'\n\n${entry.length}\n${entry}\n25\n[["e",4,null,null,123]]\n`;
    expect(parseBatchResponse(chunked).get(1)).toBe("https://x.com/a");
  });
});

describe("google news resolution", () => {
  it("costs one page per article plus one batchexecute call, then nothing on repeat", async () => {
    const { ctx, calls } = fakeCtx();
    const ids = ["A", "B", "C"];
    const urls = await resolveIds(ctx, ids, edition("all"));
    expect([...urls.values()]).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual(["POST https://news.google.com/_/DotsSplashUi/data/batchexecute"]);
    calls.length = 0;
    expect(await resolveIds(ctx, ids, edition("all"))).toEqual(urls);
    expect(calls).toHaveLength(0);
  });

  it("drops items that don't resolve", async () => {
    const { ctx } = fakeCtx();
    // The batch fixture answers calls 1-3 only; the 4th id stays unresolved.
    const urls = await resolveIds(ctx, ["A", "B", "C", "D"], edition("all"));
    expect(urls.has("D")).toBe(false);
    expect(urls.size).toBe(3);
  });

  it("returns publisher URLs with titles, publishers and dates", async () => {
    vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ["Date"] });
    const { ctx, calls } = fakeCtx();
    const results = await googleNews.response(fakeResponse(rssFx, { url: "https://news.google.com/rss/search?q=x" }), { ...PARAMS, timeRange: "week" }, ctx);
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(10); // MAX_RESOLVE
    // The batch fixture resolves three calls; one is a scanx.trade quote page, which is dropped.
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.url.includes("scanx.trade"))).toBe(false);
    for (const r of results) {
      expect(r.url).not.toContain("news.google.com");
      expect(r.author).toBeTruthy();
      expect(r.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("raises Google's sorry, consent and rate-limit responses", async () => {
    const sorry = fakeResponse("<html>sorry</html>", { status: 429, url: "https://www.google.com/sorry/index?continue=x" });
    await expect(googleNews.response(sorry, PARAMS, {} as any)).rejects.toMatchObject({ kind: "captcha" });
    expect(() => checkBlocked(200, "https://consent.google.com/ml?continue=x", "")).toThrow(expect.objectContaining({ kind: "access_denied" }));
    expect(() => checkBlocked(429, "https://news.google.com/rss/search", "")).toThrow(expect.objectContaining({ kind: "too_many_requests" }));
    await expect(googleNews.response(fakeResponse("<html>oops</html>"), PARAMS, {} as any)).rejects.toMatchObject({ kind: "parse" });
  });

  it("surfaces blocking from article pages when nothing resolves", async () => {
    const { ctx } = fakeCtx({ pageStatus: 429, pageUrl: "https://www.google.com/sorry/index" });
    await expect(resolveIds(ctx, ["A", "B"], edition("all"))).rejects.toMatchObject({ kind: "captcha" });
  });
});
