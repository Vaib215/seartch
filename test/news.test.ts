import { describe, expect, it } from "vitest";
import { dateFromHtml, dateFromUrl } from "../src/searx/dates";
import { isAbout, isNonArticle, isSpam } from "../src/searx/news_filter";
import { type MergedResult, normalizeUrl } from "../src/searx/results";
import { rankByRecency, refineNews, sortByDate, withinTimeRange } from "../src/searx/search";
import { containsTerm, mentionsSubject, splitQuery } from "../src/searx/terms";

const r = (url: string, title: string, extra: Partial<MergedResult> = {}): MergedResult => ({
  url,
  title,
  engines: ["x"],
  positions: [1],
  score: 1,
  ...extra,
});

describe("splitQuery", () => {
  it("separates the subject from reporting jargon", () => {
    expect(splitQuery("Tata Elxsi Q2 FY27 results")).toEqual({
      subject: ["tata", "elxsi"],
      jargon: expect.arrayContaining(["q2", "september quarter", "fy27", "results"]),
    });
    expect(splitQuery("Tata Elxsi Q2FY27 results").subject).toEqual(["tata", "elxsi"]);
    expect(splitQuery("did Infosys publish results today").subject).toEqual(["infosys"]);
    expect(splitQuery("when will TCS announce Q2 results").subject).toEqual(["tcs"]);
  });

  it("matches short terms as whole words only", () => {
    expect(containsTerm("ril q2 profit", "ril")).toBe(true);
    expect(containsTerm("april auto sales", "ril")).toBe(false);
    expect(containsTerm("tataelxsi shares", "elxsi")).toBe(true);
  });

  it("lets long subjects miss one word", () => {
    const terms = splitQuery("RBI repo rate decision");
    expect(mentionsSubject("RBI keeps repo rate unchanged at 5.5%", terms)).toBe(true);
    expect(mentionsSubject("Fed holds rates", terms)).toBe(false);
  });
});

describe("dates", () => {
  it("reads publish dates encoded in article URLs", () => {
    const day = (url: string) => dateFromUrl(url)?.slice(0, 10);
    expect(day("https://www.livemint.com/market/stock-market-news/tata-elxsi-q2-results-impact-11791906874922.html")).toBe("2026-10-13");
    expect(day("https://www.livemint.com/market/stock-market-news/infosys-q2-results-11760607013880.html")).toBe("2025-10-16");
    expect(day("https://www.hindustantimes.com/india-news/elon-musk-asks-why-starlink-101791478668264.html")).toBe("2026-10-08");
    expect(day("https://www.business-standard.com/companies/news/reliance-cheaper-jio-126100800335_1.html")).toBe("2026-10-08");
    expect(day("https://www.business-standard.com/markets/news/tata-elxsi-q2-results-125101000195_1.html")).toBe("2025-10-10");
    expect(day("https://www.reuters.com/world/india/hdfcs-next-ceo-2026-10-08/")).toBe("2026-10-08");
    expect(day("https://www.bloomberg.com/news/articles/2026-10-07/india-s-110-billion-hdfc-bank")).toBe("2026-10-07");
    expect(day("https://www.theguardian.com/environment/2026/oct/08/tortoises")).toBe("2026-10-08");
    expect(dateFromUrl("https://economictimes.indiatimes.com/markets/stocks/news/x/articleshow/134931786.cms")).toBeUndefined();
  });

  it("reads publish dates from page metadata", () => {
    expect(dateFromHtml('<script type="application/ld+json">{"datePublished":"2026-10-14T10:05:00+05:30"}</script>')).toBe(
      "2026-10-14T04:35:00.000Z",
    );
    expect(dateFromHtml('<meta property="article:published_time" content="2026-10-13T18:00:00Z">')).toBe("2026-10-13T18:00:00.000Z");
    expect(dateFromHtml('<meta content="2026-10-12T08:00:00Z" property="article:published_time">')).toBe("2026-10-12T08:00:00.000Z");
    expect(dateFromHtml("<html><head><title>x</title></head></html>")).toBeUndefined();
  });
});

describe("news filter", () => {
  it("drops listing, quote and social pages", () => {
    expect(isNonArticle("https://economictimes.indiatimes.com/topic/tata-elxsi-earnings")).toBe(true);
    expect(isNonArticle("https://www.livemint.com/market/market-stats/tata-elxsi-q2-results-S0003158")).toBe(true);
    expect(isNonArticle("https://www.moneycontrol.com/markets/financials/quarterly-results/tataelxsi-TE/")).toBe(true);
    expect(isNonArticle("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isNonArticle("https://economictimes.indiatimes.com/markets/stocks/news/x/articleshow/134931786.cms")).toBe(false);
  });

  it("drops gambling and crypto spam unless asked for", () => {
    expect(isSpam("Best Aviator india 2026 — Top Platforms Real Money", "", "best budget phone india")).toBe(true);
    expect(isSpam("Best Cricket Betting Apps India 2026", "", "cricket betting regulation")).toBe(false);
    expect(isSpam("Tata Elxsi Q2 results", "", "tata elxsi")).toBe(false);
  });

  it("keeps only stories about the subject (no TCS in a Tata Elxsi search)", () => {
    const terms = splitQuery("Tata Elxsi Q2 results");
    expect(isAbout(r("https://x/1", "Tata Elxsi shares jump 7% after Q2 results"), terms, [])).toBe(true);
    expect(isAbout(r("https://x/2", "TCS Q2 results: profit up 15%", { content: "Tata Consultancy Services" }), terms, [])).toBe(false);
    // The headline may not repeat the name; the URL slug usually does.
    expect(isAbout(r("https://x/tata-elxsi-q2-preview", "IT midcap Q2 preview"), terms, [])).toBe(true);
  });

  it("uses a resolved company's aliases when there are any", () => {
    const ril = [{ aliases: ["ril", "reliance industries", "reliance"] }];
    const terms = splitQuery("RIL results");
    expect(isAbout(r("https://x/1", "Reliance Industries Q2 profit beats estimates"), terms, ril)).toBe(true);
    expect(isAbout(r("https://x/2", "April car sales jump"), terms, ril)).toBe(false);
  });

  it("refineNews counts what it drops", () => {
    const dropped = { nonArticle: 0, spam: 0, offTopic: 0 };
    const kept = refineNews(
      [
        r("https://economictimes.indiatimes.com/topic/tata-elxsi", "Tata Elxsi news"),
        r("https://spam.example/x", "Tata Elxsi casino bonus"),
        r("https://news.example/tcs", "TCS Q2 results"),
        r("https://news.example/te", "Tata Elxsi Q2 results"),
      ],
      "Tata Elxsi Q2 results",
      [],
      dropped,
    );
    expect(kept.map((x) => x.url)).toEqual(["https://news.example/te"]);
    expect(dropped).toEqual({ nonArticle: 1, spam: 1, offTopic: 1 });
  });
});

describe("ranking and ranges", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");

  it("enforces the time range on real dates and keeps undated results", () => {
    const results = [
      r("https://a/new", "new", { publishedDate: "2026-10-13T00:00:00Z" }),
      r("https://a/old", "old", { publishedDate: "2026-06-01T00:00:00Z" }),
      r("https://a/undated", "undated"),
    ];
    expect(withinTimeRange(results, "week", now).map((x) => x.url)).toEqual(["https://a/new", "https://a/undated"]);
    expect(withinTimeRange(results, "quarter", now).map((x) => x.url)).toEqual(["https://a/new", "https://a/undated"]);
    expect(withinTimeRange(results, "year", now)).toHaveLength(3);
  });

  it("sorts newest first with undated results last", () => {
    const results = [
      r("https://a/undated", "u"),
      r("https://a/older", "o", { publishedDate: "2026-10-01T00:00:00Z" }),
      r("https://a/newer", "n", { publishedDate: "2026-10-13T00:00:00Z" }),
    ];
    expect(sortByDate(results).map((x) => x.url)).toEqual(["https://a/newer", "https://a/older", "https://a/undated"]);
  });

  it("prefers a fresh story over an equally scored year-old one", () => {
    const results = [
      r("https://a/last-year", "Q2 FY26", { score: 2, publishedDate: "2025-10-10T00:00:00Z" }),
      r("https://a/this-week", "Q2 FY27", { score: 1.5, publishedDate: "2026-10-13T00:00:00Z" }),
    ];
    expect(rankByRecency(results, now).map((x) => x.url)).toEqual(["https://a/this-week", "https://a/last-year"]);
  });
});

describe("AMP canonicalisation", () => {
  it("folds AMP copies into the article URL", () => {
    expect(normalizeUrl("https://timesofindia.indiatimes.com/world/x/amp_articleshow/134774150.cms")?.href).toBe(
      "https://timesofindia.indiatimes.com/world/x/articleshow/134774150.cms",
    );
    expect(normalizeUrl("https://www.indiatoday.in/amp/world/story/x-3012747-2026-10-08")?.href).toBe(
      "https://www.indiatoday.in/world/story/x-3012747-2026-10-08",
    );
    expect(normalizeUrl("https://site.example/a?outputType=amp")?.href).toBe("https://site.example/a");
  });
});

describe("passing mentions", () => {
  it("ranks headline mentions above snippet-only mentions", () => {
    const dropped = { nonArticle: 0, spam: 0, offTopic: 0 };
    const kept = refineNews(
      [
        r("https://news.example/vinfast-loi", "VinFast signs LoIs for 50 dealers", { score: 2, content: "rivals include Hero MotoCorp", publishedDate: "2026-10-13T00:00:00Z" }),
        r("https://news.example/hero-q2", "Hero MotoCorp Q2 preview", { score: 1, publishedDate: "2026-10-13T00:00:00Z" }),
      ],
      "Hero MotoCorp Q2 results",
      [],
      dropped,
    );
    expect(kept).toHaveLength(2);
    expect(rankByRecency(kept, Date.parse("2026-10-14T00:00:00Z"))[0].url).toBe("https://news.example/hero-q2");
  });
});
