import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Company, type FuzzyMatch, _clearCompanyMemo, aliasesFor, configureTickerSearch } from "../../src/searx/companies";
import { ANALYSIS_SITES, analysis, looksLikeAnalysis, publisher, rankAnalysis } from "../../src/searx/engines/analysis";
import { _resetResearchCache, commonName } from "../../src/searx/engines/research_common";
import { configureTinyfish, mapTinyfishResults } from "../../src/searx/tinyfish";
import { EngineError } from "../../src/searx/types";
import bsFx from "../fixtures/analysis-bs.json?raw";
import tfFx from "../fixtures/analysis-tinyfish.json?raw";
import { PARAMS } from "../helpers";

const GENUS_M: FuzzyMatch = {
  nseTicker: "GENUSPOWER",
  bseTicker: "530343",
  companyName: "Genus Power Infrastructures Ltd.",
  isinNumber: "INE955D01029",
  marketCap: 10000,
  matchType: "exact",
  confidence: 1,
};
const GENUS: Company = { name: GENUS_M.companyName, nse: "GENUSPOWER", bse: "530343", aliases: aliasesFor(GENUS_M, "genus power") };
const tfItems = () => JSON.parse(tfFx).output.results;

describe("analysis ranking", () => {
  it("drops quote pages and filings, keeps analysis first", () => {
    const ranked = rankAnalysis(mapTinyfishResults(tfItems()), "Genus Power business model", GENUS, Date.parse("2026-10-17T00:00:00Z"));
    const urls = ranked.map((r) => r.url);
    expect(urls[0]).toBe("https://www.valueresearchonline.com/stories/228866/genus-power-s-profits-more-than-doubled-where-is-the-cash/");
    expect(urls.some((u) => /stockpricequote|\/stocks\/42170\/|market-stats|\/announcements\//.test(u))).toBe(false);
    // Price-move news ranks below the broker note and the analysis.
    const broker = ranked.findIndex((r) => r.title.endsWith("broker research note (PDF)"));
    const soar = ranked.findIndex((r) => /shares soar/.test(r.title));
    expect(broker).toBeGreaterThan(0);
    expect(soar).toBeGreaterThan(broker);
    expect(ranked[0].author).toBe("Value Research");
  });

  it("dates undated results from their URL", () => {
    const [r] = rankAnalysis(
      [{ url: "https://www.livemint.com/companies/news/genus-power-explained-what-drives-its-cash-flow-11748839471230.html", title: "Genus Power explained: cash flow" }],
      "Genus Power cash flow",
      GENUS,
    );
    expect(r.publishedDate).toMatch(/^2025-06-02/);
  });

  it("keeps only analysis-like stories from the newest-first site search", () => {
    const news = { url: "https://www.business-standard.com/markets/news/genus-power-tanks-12-on-huge-volumes-126063000302_1.html", title: "Genus Power tanks 12% on huge volumes" };
    const why = { url: "https://www.business-standard.com/companies/news/why-genus-power-cash-flow-lags-profits-126063000303_1.html", title: "Why Genus Power's cash flow lags its profits" };
    expect(looksLikeAnalysis(news, "Genus Power", GENUS)).toBe(false);
    expect(looksLikeAnalysis(why, "Genus Power", GENUS)).toBe(true);
  });

  it("names publishers and companies the way articles do", () => {
    expect(publisher("https://www.thehindubusinessline.com/portfolio/x/article1.ece")).toBe("BusinessLine");
    expect(commonName(GENUS)).toBe("Genus Power");
    expect(ANALYSIS_SITES).toContain("finshots.in");
  });
});

describe("analysis engine", () => {
  const queries: { q: string; domains: string }[] = [];

  beforeEach(() => {
    queries.length = 0;
    _resetResearchCache();
    configureTickerSearch(async () => [GENUS_M]);
    configureTinyfish({ tinyfish: "test-key" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.hostname !== "api.search.tinyfish.ai") return new Response("unexpected", { status: 500 });
      queries.push({ q: url.searchParams.get("query") ?? "", domains: url.searchParams.get("include_domains") ?? "" });
      return Response.json({ results: tfItems() });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configureTickerSearch(undefined);
    configureTinyfish({});
    _clearCompanyMemo();
  });

  const ctx = (bs: () => Response) => {
    const urls: string[] = [];
    return {
      urls,
      ctx: {
        memo: new Map(),
        fetch: async (input: string | URL) => {
          const url = String(input);
          urls.push(url);
          return url.startsWith("https://apibs.business-standard.com/") ? bs() : new Response("not found", { status: 404 });
        },
      },
    };
  };

  it("searches the analysis sites for the company and the query's topic", async () => {
    const { ctx: c, urls } = ctx(() => new Response(bsFx));
    const results = await analysis.search!({ ...PARAMS, query: "Genus Power cash flow" }, c);
    expect(queries).toHaveLength(2);
    expect(queries).toEqual(
      expect.arrayContaining([
        { q: "Genus Power cash flow analysis", domains: ANALYSIS_SITES.join(",") },
        { q: "Genus Power cash flow explained", domains: "valueresearchonline.com,capitalmind.in,finshots.in,thehindubusinessline.com" },
      ]),
    );
    expect(urls.some((u) => u.startsWith("https://apibs.business-standard.com/search?listData="))).toBe(true);
    expect(results[0].title).toMatch(/^Genus Power's profits more than doubled/);
    // The site search's results roundup and price-move news are not analysis.
    expect(results.some((r) => /693 more|tanks 12%/.test(r.title))).toBe(false);
    expect(results.every((r) => /genus/i.test(`${r.title} ${r.url} ${r.content}`))).toBe(true);
  });

  it("still answers when Business Standard's search fails", async () => {
    const { ctx: c } = ctx(() => new Response("blocked", { status: 403 }));
    const results = await analysis.search!({ ...PARAMS, query: "Genus Power business model" }, c);
    expect(results.length).toBeGreaterThan(3);
  });

  it("throws an EngineError when every source fails", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("down", { status: 500 }));
    const { ctx: c } = ctx(() => new Response("down", { status: 500 }));
    await expect(analysis.search!({ ...PARAMS, query: "Genus Power business model" }, c)).rejects.toBeInstanceOf(EngineError);
  });

  it("returns nothing when no company resolves", async () => {
    configureTickerSearch(undefined);
    const { ctx: c, urls } = ctx(() => new Response(bsFx));
    expect(await analysis.search!({ ...PARAMS, query: "how do smart meter makers collect cash" }, c)).toEqual([]);
    expect(urls).toEqual([]);
    expect(queries).toEqual([]);
  });
});
