import { describe, expect, it } from "vitest";
import {
  bingNews,
  filterFeedItems,
  indiaFinanceNews,
  parseRss,
  unwrapBingNews,
} from "../../src/searx/engines/india_news";
import bingFx from "../fixtures/bing_news.xml?raw";
import etFx from "../fixtures/feed-et-markets.xml?raw";
import mintFx from "../fixtures/feed-mint-markets.xml?raw";
import { PARAMS, fakeResponse } from "../helpers";

const ctx = { fetch, memo: new Map() } as any;

describe("bing news", () => {
  it("defaults to the Indian market and maps time ranges to qft", async () => {
    const req = (await bingNews.request({ ...PARAMS, query: "Infosys Q2", timeRange: "week" }, ctx))!;
    const u = new URL(req.url);
    expect(u.searchParams.get("format")).toBe("rss");
    expect(u.searchParams.get("cc")).toBe("IN");
    expect(u.searchParams.get("qft")).toBe('interval="8"');
  });

  it("parses RSS into publisher URLs with dates and sources", async () => {
    const results = await bingNews.response(fakeResponse(bingFx), PARAMS, ctx);
    expect(results.length).toBeGreaterThan(3);
    for (const r of results) {
      expect(r.url).not.toContain("bing.com");
      expect(r.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(results.some((r) => r.author === "The Financial Express")).toBe(true);
  });

  it("reports an item-less feed (Bing's soft block) as an error", () => {
    const empty = '<rss><channel><title>Infosys - BingNews</title></channel></rss>';
    expect(() => bingNews.response(fakeResponse(empty), PARAMS, ctx)).toThrow(/empty feed/);
  });

  it("unwraps apiclick links", () => {
    expect(unwrapBingNews("http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fx.com%2fa&c=1")).toBe("https://x.com/a");
    expect(unwrapBingNews("https://x.com/b")).toBe("https://x.com/b");
  });
});

describe("india finance news", () => {
  it("restricts Yandex to Indian financial publishers", async () => {
    const req = (await indiaFinanceNews.request({ ...PARAMS, query: "PB Fintech" }, ctx))!;
    const text = new URL(req.url).searchParams.get("text")!;
    expect(text).toContain("PB Fintech (site:economictimes.indiatimes.com | site:livemint.com");
  });
});

describe("india market feeds", () => {
  it("parses publisher feeds, including CDATA-wrapped fields", () => {
    for (const fx of [etFx, mintFx]) {
      const items = parseRss(fx);
      expect(items.length).toBeGreaterThan(10);
      expect(items[0].link).toMatch(/^https:\/\//);
      expect(items.filter((i) => i.date).length).toBeGreaterThan(items.length / 2);
    }
  });

  it("requires the subject, ranks by shared jargon, then newest first", () => {
    const items = [
      { title: "Infosys Q2 preview", link: "https://a/1", description: "", date: "2026-10-07T00:00:00Z" },
      { title: "TCS and Infosys rally", link: "https://a/2", description: "IT stocks up", date: "2026-10-08T00:00:00Z" },
      { title: "Wipro results", link: "https://a/3", description: "", date: "2026-10-08T01:00:00Z" },
    ];
    expect(filterFeedItems(items, "Infosys news today").map((i) => i.link)).toEqual(["https://a/2", "https://a/1"]);
    // Jargon no longer has to match; it only ranks.
    expect(filterFeedItems(items, "infosys q2").map((i) => i.link)).toEqual(["https://a/1", "https://a/2"]);
  });

  it("treats Q2, Q2FY27 and 'September quarter' as the same thing", () => {
    const items = [
      { title: "Tata Elxsi shares jump 7% after Q2 results", link: "https://a/1", description: "", date: "2026-10-14T05:00:00Z" },
      { title: "Tata Elxsi September quarter profit rises 10%", link: "https://a/2", description: "", date: "2026-10-13T12:00:00Z" },
      { title: "Tata Elxsi Q2FY27: margins expand", link: "https://a/3", description: "", date: "2026-10-13T13:00:00Z" },
      { title: "TCS Q2 results: profit up 15%", link: "https://a/4", description: "Tata group IT major", date: "2026-10-08T12:00:00Z" },
    ];
    const long = filterFeedItems(items, "Tata Elxsi Q2 FY27 results").map((i) => i.link);
    const short = filterFeedItems(items, "Tata Elxsi Q2 results").map((i) => i.link);
    expect(new Set(long)).toEqual(new Set(["https://a/1", "https://a/2", "https://a/3"]));
    expect(new Set(short)).toEqual(new Set(long));
  });

  it("matches a resolved company's aliases instead of the query words", () => {
    const items = [
      { title: "Reliance Industries Q2 profit beats estimates", link: "https://a/1", description: "", date: "2026-10-14T00:00:00Z" },
      { title: "April auto sales", link: "https://a/2", description: "", date: "2026-10-14T00:00:00Z" },
    ];
    expect(filterFeedItems(items, "RIL results", ["ril", "reliance industries"]).map((i) => i.link)).toEqual(["https://a/1"]);
  });
});
