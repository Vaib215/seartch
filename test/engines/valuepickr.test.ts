import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FuzzyMatch, _clearCompanyMemo, aliasesFor, configureTickerSearch } from "../../src/searx/companies";
import { _resetResearchCache } from "../../src/searx/engines/research_common";
import { matchTopics, parseSitemap, parseSitemapIndex, toResult, valuepickr } from "../../src/searx/engines/valuepickr";
import sitemapFx from "../fixtures/valuepickr-sitemap.xml?raw";
import topicFx from "../fixtures/valuepickr-topic.json?raw";
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
const INFY_M: FuzzyMatch = { ...GENUS_M, nseTicker: "INFY", bseTicker: "500209", companyName: "Infosys Ltd.", isinNumber: "INE009A01021" };

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://forum.valuepickr.com/sitemap_recent.xml</loc></sitemap>
  <sitemap><loc>https://forum.valuepickr.com/sitemap_1.xml</loc></sitemap>
</sitemapindex>`;

describe("valuepickr sitemap", () => {
  it("lists topic sitemaps and their topics with last activity", () => {
    expect(parseSitemapIndex(INDEX)).toEqual(["https://forum.valuepickr.com/sitemap_1.xml"]);
    const topics = parseSitemap(sitemapFx);
    expect(topics.length).toBeGreaterThan(40);
    expect(topics.find((t) => t.id === 26679)).toMatchObject({ slug: "genus-power-smart-metering" });
    expect(topics.every((t) => t.lastmod)).toBe(true);
  });

  it("matches the company's names as whole words in slugs, its own threads first", () => {
    const topics = [
      { slug: "hcl-infosystems", id: 1622, lastmod: Date.parse("2026-09-01") },
      { slug: "a-tale-of-3-companies-tcs-vs-infy-vs-hcl-tech", id: 9046, lastmod: Date.parse("2026-10-01") },
      { slug: "infosys-limited-are-we-getting-a-discount-or-no", id: 8124, lastmod: Date.parse("2026-06-23") },
      { slug: "genus-power-smart-metering", id: 26679, lastmod: Date.parse("2026-09-19") },
    ];
    const infy = aliasesFor(INFY_M, "infosys");
    expect(matchTopics(topics, "Infosys business model", infy).map((t) => t.id)).toEqual([8124, 9046]);
    expect(matchTopics(topics, "Genus Power cash flow", aliasesFor(GENUS_M, "genus power")).map((t) => t.id)).toEqual([26679]);
  });

  it("turns topic JSON into a dated result with an excerpt of the first post", () => {
    const r = toResult({ slug: "genus-power-smart-metering", id: 26679 }, JSON.parse(topicFx));
    expect(r.url).toBe("https://forum.valuepickr.com/t/genus-power-smart-metering/26679");
    expect(r.title).toBe("Genus Power - Smart Metering");
    expect(r.publishedDate).toBe("2026-09-19T08:04:23.974Z");
    expect(r.content).toMatch(/^182 posts · 53421 views · started Dec 2019 · last post 19 Sep 2026\. Starting a dedicated thread for Genus Power/);
    expect(r.author).toBe("ValuePickr");
  });
});

describe("valuepickr engine", () => {
  beforeEach(() => {
    _resetResearchCache();
    configureTickerSearch(async () => [GENUS_M]);
  });
  afterEach(() => {
    configureTickerSearch(undefined);
    _clearCompanyMemo();
  });

  function ctx() {
    const urls: string[] = [];
    return {
      urls,
      ctx: {
        memo: new Map(),
        fetch: async (input: string | URL) => {
          const url = String(input);
          urls.push(url);
          if (url === "https://forum.valuepickr.com/sitemap.xml") return new Response(INDEX);
          if (url === "https://forum.valuepickr.com/sitemap_1.xml") return new Response(sitemapFx);
          if (url === "https://forum.valuepickr.com/t/26679.json") return new Response(topicFx);
          return new Response("not found", { status: 404 });
        },
      },
    };
  }

  it("finds the company's thread without touching /search (disallowed by robots.txt)", async () => {
    const { ctx: c, urls } = ctx();
    const results = await valuepickr.search!({ ...PARAMS, query: "Genus Power business model" }, c);
    expect(results.map((r) => r.title)).toEqual(["Genus Power - Smart Metering"]);
    expect(results[0].publishedDate).toBe("2026-09-19T08:04:23.974Z");
    expect(urls.some((u) => u.includes("/search"))).toBe(false);
  });

  it("returns nothing when no company resolves", async () => {
    configureTickerSearch(undefined);
    const { ctx: c, urls } = ctx();
    expect(await valuepickr.search!({ ...PARAMS, query: "smart meters" }, c)).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("keeps the sitemap index cached between searches", async () => {
    await valuepickr.search!({ ...PARAMS, query: "Genus Power" }, ctx().ctx);
    const again = ctx();
    await valuepickr.search!({ ...PARAMS, query: "Genus Power business model" }, again.ctx);
    expect(again.urls.filter((u) => u.includes("sitemap_1"))).toEqual([]);
  });

  it("falls back to the sitemap entry when a topic can't be read", async () => {
    const { ctx: c } = ctx();
    const failing = { ...c, fetch: async (input: string | URL) => (String(input).endsWith(".json") ? new Response("busy", { status: 429 }) : c.fetch(input)) };
    const results = await valuepickr.search!({ ...PARAMS, query: "Genus Power" }, failing);
    expect(results[0]).toMatchObject({ title: "Genus Power Smart Metering", url: "https://forum.valuepickr.com/t/genus-power-smart-metering/26679" });
    expect(results[0].publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
