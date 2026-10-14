import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _internal,
  bsEncode,
  bsMatches,
  businessStandard,
  economicTimes,
  financialExpress,
  parseEtDate,
} from "../../src/searx/engines/india_publishers";
import bsFx from "../fixtures/pub-business-standard.json?raw";
import etFx from "../fixtures/pub-economic-times.html?raw";
import feFx from "../fixtures/pub-financial-express.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

const noFetch = vi.fn(async () => {
  throw new Error("network not allowed in tests");
});
const ctx = { fetch: noFetch, memo: new Map() } as any;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(() => {
  vi.useRealTimers();
  noFetch.mockClear();
});

describe("financial express", () => {
  it("searches by relevance without a time range", async () => {
    const req = (await financialExpress.request({ ...PARAMS, query: "Infosys" }, ctx))!;
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://www.financialexpress.com/wp-json/wp/v2/posts");
    expect(u.searchParams.get("search")).toBe("Infosys");
    expect(u.searchParams.get("orderby")).toBe("relevance");
    expect(u.searchParams.get("after")).toBeNull();
    expect(u.searchParams.get("_fields")).toContain("date_gmt");
  });

  it("keeps relevance order within the time range", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-09T00:00:00Z"), toFake: ["Date"] });
    const req = (await financialExpress.request({ ...PARAMS, query: "Infosys", timeRange: "week", pageno: 2 }, ctx))!;
    const u = new URL(req.url);
    expect(u.searchParams.get("orderby")).toBe("relevance");
    expect(u.searchParams.get("after")).toBe("2026-10-02T00:00:00");
    expect(u.searchParams.get("page")).toBe("2");
  });

  it("parses posts into article URLs with clean titles, excerpts and UTC dates", async () => {
    const results = await financialExpress.response(fakeResponse(feFx), PARAMS, ctx);
    expect(results.length).toBe(20);
    for (const r of results) {
      expect(r.url).toMatch(/^https:\/\/www\.financialexpress\.com\/.+[-/]\d+\/$/);
      expect(r.title).not.toMatch(/&#\d+;|<|>/);
      expect(r.content).toBeTruthy();
      expect(r.content).not.toMatch(/<p>/);
      expect(r.publishedDate).toMatch(ISO);
      expect(r.author).toBe("Financial Express");
    }
    expect(results[0]).toMatchObject({
      title: "Infosys signs 10-year AI deal with Crocs to modernise global IT operations",
      publishedDate: "2026-08-07T04:28:20.000Z",
    });
    // HTML entities in titles are decoded.
    expect(results.some((r) => r.title.includes("‘drive bold transformation’"))).toBe(true);
  });

  it("drops posts outside the time range and treats a past-the-end page as empty", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-10T00:00:00Z"), toFake: ["Date"] });
    const results = await financialExpress.response(fakeResponse(feFx), { ...PARAMS, timeRange: "week" }, ctx);
    expect(results.map((r) => r.publishedDate)).toEqual(["2026-08-07T04:28:20.000Z"]);
    const past = fakeResponse('{"code":"rest_post_invalid_page_number"}', { status: 400 });
    expect(await financialExpress.response(past, { ...PARAMS, pageno: 9 }, ctx)).toEqual([]);
  });
});

describe("economic times", () => {
  it("requests the article-only topic list", async () => {
    const req = (await economicTimes.request({ ...PARAMS, query: "PB Fintech", pageno: 3 }, ctx))!;
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://economictimes.indiatimes.com/topics_all.cms");
    expect(u.searchParams.get("type")).toBe("article");
    expect(u.searchParams.get("query")).toBe("PB Fintech");
    expect(u.searchParams.get("curpg")).toBe("3");
  });

  it("parses the result list with articleshow URLs, snippets and IST dates", async () => {
    const results = await economicTimes.response(fakeResponse(etFx), PARAMS, ctx);
    expect(results.length).toBe(20);
    for (const r of results) {
      expect(r.url).toMatch(/^https:\/\/economictimes\.indiatimes\.com\/.+\/articleshow\/\d+\.cms$/);
      expect(r.title.length).toBeGreaterThan(10);
      expect(r.content!.length).toBeGreaterThan(30);
      expect(r.publishedDate).toMatch(ISO);
      expect(r.author).toBe("The Economic Times");
    }
    expect(results[1]).toMatchObject({
      title: "US suspends TCS, Infosys, Wipro, HCLTech, Cognizant and three other firms from PERM green card programme",
      url: "https://economictimes.indiatimes.com/nri/latest-updates/us-suspends-tcs-infosys-wipro-hcltech-cognizant-and-three-other-firms-from-perm-green-card-programme/articleshow/134799468.cms",
      publishedDate: "2026-10-08T19:07:00.000Z", // 09 Oct, 2026, 12.37 AM IST
    });
    // Newest first, as ET lists them.
    const dates = results.map((r) => Date.parse(r.publishedDate!));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it("returns nothing for ET's no-result fragment", async () => {
    const empty = '<a class="curpage flt" href="#1"></a><div class="no-result">There are no news on <span class="query">zzz</span></div>';
    expect(await economicTimes.response(fakeResponse(empty), PARAMS, ctx)).toEqual([]);
  });

  it("parses ET dates as IST", () => {
    expect(parseEtDate("09 Oct, 2026, 12.56 AM IST")).toBe("2026-10-08T19:26:00.000Z");
    expect(parseEtDate("27 Sep, 2026, 04.31 PM IST")).toBe("2026-09-27T11:01:00.000Z");
    expect(parseEtDate("12 Mar, 2025")).toBe("2025-03-11T18:30:00.000Z");
    expect(parseEtDate("yesterday")).toBeUndefined();
  });
});

describe("business standard", () => {
  it("encodes the request the way the site's client does", async () => {
    const now = new Date("2026-10-08T19:42:00Z"); // 9 Oct in IST
    expect(bsEncode("QlNBUElTRUNSRVRLRVk", now)).toBe(
      [..."0919QlNBUElTRUNSRVRLRVkbs255T"].map((c) => {
        const A = "95867qrstuvwxyzabcdefghijklmnop01234JKLMNOPQRSTUVWXYZABCDEFGHI";
        return A[Math.floor(c.charCodeAt(0) / 62)] + A[c.charCodeAt(0) % 62];
      }).join(""),
    );
    const req = (await businessStandard.request({ ...PARAMS, query: "TCS" }, ctx))!;
    expect(req.url).toMatch(/^https:\/\/apibs\.business-standard\.com\/search\?listData=[0-9a-zA-Z]+$/);
    expect(req.headers!["x-api-token"]).toMatch(/^[0-9a-zA-Z]+$/);
    expect(_internal.bsListData('"TCS"', 1)).toBe('{"type":"news","limit":20,"page":1,"keyword":"\\"TCS\\""}');
  });

  it("keeps the encoded payload under the client's 99-character limit", () => {
    const data = _internal.bsListData("a very long query ".repeat(10), 2);
    expect(data.length).toBeLessThanOrEqual(99);
    expect(JSON.parse(data).page).toBe(2);
  });

  it("parses news into article URLs with headlines, sub-headings and dates", async () => {
    const results = await businessStandard.response(fakeResponse(bsFx), { ...PARAMS, query: "Infosys" }, ctx);
    expect(results.length).toBe(20);
    expect(noFetch).not.toHaveBeenCalled();
    for (const r of results) {
      expect(r.url).toMatch(/^https:\/\/www\.business-standard\.com\/[a-z0-9-]+\/.+_1\.html$/);
      expect(r.title.toLowerCase()).toContain("infosys");
      expect(r.publishedDate).toMatch(ISO);
      expect(r.author).toBe("Business Standard");
    }
    expect(results[2]).toMatchObject({
      title: "Infosys Ltd drops for fifth straight session",
      url: "https://www.business-standard.com/markets/capital-market-news/infosys-ltd-drops-for-fifth-straight-session-126092200620_1.html",
      publishedDate: "2026-09-22T09:01:10.000Z",
    });
    expect(results.filter((r) => r.content).length).toBeGreaterThan(5);
  });

  it("drops stories that aren't about the query", async () => {
    const results = await businessStandard.response(fakeResponse(bsFx), { ...PARAMS, query: "Wipro" }, ctx);
    expect(results.every((r) => `${r.title} ${r.content} ${r.url}`.toLowerCase().includes("wipro"))).toBe(true);
    expect(results.length).toBeLessThan(5);
  });

  it("reports API errors", () => {
    const bad = fakeResponse('{"success":false,"statusCode":400,"data":{},"message":"TypeError: x"}');
    return expect(businessStandard.response(bad, { ...PARAMS, query: "Infosys" }, ctx)).rejects.toThrow(/Business Standard API: TypeError/);
  });

  it("matches on the leading term and tolerates one missing term in long queries", () => {
    expect(bsMatches("hdfc bank cuts mclr rates", ["hdfc", "bank", "results"])).toBe(true);
    expect(bsMatches("q2 results today: tcs, indian bank", ["hdfc", "bank", "results"])).toBe(false);
    expect(bsMatches("fintech stocks decline", ["pb", "fintech"])).toBe(false);
  });
});
